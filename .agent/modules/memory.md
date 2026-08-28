# Module: Memory

## Purpose

Memory is curated, approved, scoped long-term knowledge. It is not raw activity,
Runtime Context continuity, a prompt cache, or an adapter-owned store.

## Ownership and invariants

- `server/src/modules/memory/` owns Memory read/proposal/apply behavior and its
  Retrieval domain adapter.
- The Memory applier is the only writer of active `memory_entries`, by either
  of two routes ([ADR 0003](../decisions/0003-memory-proposal-flow.md)): a
  proposal a person approved, or an Agent's own bounded write
  (`applyDirect`) that stays private, normal-sensitivity and about the person
  in the turn. No adapter, job or route inserts around it.
- User Memory is human-owned and Project-free. Project Memory is Project-owned
  and shared only through the Project access boundary. `agent_id` is producing
  Agent provenance, never an ownership or read-expansion key.
- Every read applies Space, status/deletion, owner/visibility/grant, Memory
  scope, and Project membership gates before content leaves the domain.
- Cross-person reads write the shared privacy audit before returning content.
- Memory maintenance may create private report artifacts and review packets; it
  never writes active Memory directly.

## Runtime Context boundary

Memory search is a read-only candidate authority. Runtime Context may acquire
Memory candidates for the instructing user and exact Project scope, but it
revalidates the canonical rows and immutable execution-control snapshot before
persisting an accepted Delivery. Adapters cannot query Memory directly.

Accepted source ownership/visibility contributes to the Run taint summary used
as an output-publication ceiling. Safe Invocation Snapshots retain canonical
source refs for audit and content-demotion disclosure. Context Events and
checkpoints never promote content into Memory; promotion is a write under ADR
0003, and one that carries no rationale of its own is a proposal.

The retired Context Builder/Compiler/Prepare service, Context Snapshots/Digests,
manual context attachments, chat candidate bundle, and vendor context files are
not Memory responsibilities and must not be reintroduced.

## Main write flows

**A person, through the public API.** `POST /memory` and `PATCH /memory/{id}`
create a pending create/update proposal; proposal review verifies placement,
source trust, provenance and policy; the applier writes the canonical version
and its provenance links. `DELETE /memory/{id}` archives the caller's **own**
entry outright and answers 200 with it (ADR 0003 §3 — a proposal there was
the person filing a request with themselves); someone else's still creates an
archive proposal and answers 202. `POST /memory/{id}/restore` is the reverse,
owner-only, and also restores the version a revision replaced once no newer
version is active.

**An Agent, in a person's turn.** `memory.remember` / `memory.revise` go
through `applyDirect`: a new version, `created_by = agent:<id>`,
`approved_by = null`, `created_from_proposal_id = null`, and one `run`
provenance link carrying the rationale and the session. It is bounded rather
than pre-approved — private, normal-sensitivity, about the acting person, and
a revision only of what the Agent itself wrote and the person owns. Anything
that would change reach becomes a proposal instead of an error, and takes the
review above, where the person's accept is what the source-monitoring gate
reads as confirmation. The direct route does not run that gate: what stands
in for it is §2's bounds — the write is private to one person, versioned,
attributable, and archived in one action from the Memory page or the
Project's updates.

Retrieval projections are derived and rebuildable in both flows; they never
become the canonical Memory store.

## Related files

- `.agent/architecture/MEMORY_CONTEXT_RUNTIME.md`
- `.agent/architecture/MEMORY_MAINTENANCE.md`
- `server/src/modules/memory/`
- `server/src/modules/runtimeContext/`
- `server/src/modules/proposals/`
- `server/src/modules/retrieval/`
- `server/src/db/schema/memory.ts`

## Related decisions

- [0003-memory-proposal-flow.md](../decisions/0003-memory-proposal-flow.md)
- [0014-unified-runtime-context-engine.md](../decisions/0014-unified-runtime-context-engine.md)
