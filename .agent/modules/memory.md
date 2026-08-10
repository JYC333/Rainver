# Module: Memory

## Purpose

Memory is curated, approved, scoped long-term knowledge. It is not raw activity,
Runtime Context continuity, a prompt cache, or an adapter-owned store.

## Ownership and invariants

- `server/src/modules/memory/` owns Memory read/proposal/apply behavior and its
  Retrieval domain adapter.
- Active `memory_entries` are created, superseded, or archived only after normal
  Proposal review; public Memory commands create proposals, never active rows.
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
checkpoints never promote content into Memory; any promotion still requires a
proposal and approval.

The retired Context Builder/Compiler/Prepare service, Context Snapshots/Digests,
manual context attachments, chat candidate bundle, and vendor context files are
not Memory responsibilities and must not be reintroduced.

## Main write flow

1. `POST /memory`, `PATCH /memory/{id}`, or `DELETE /memory/{id}` creates a
   pending create/update/archive proposal.
2. Proposal review verifies placement, source trust, provenance, and policy.
3. The Memory applier writes the canonical version and provenance links.
4. Retrieval projections are derived and rebuildable; they never become the
   canonical Memory store.

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
