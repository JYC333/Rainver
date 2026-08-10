# Memory Evolution Plan

Status: forward-looking plan, updated 2026-06-21.

This document describes planned Memory-quality work. It is distinct from the
Knowledge retrieval substrate + context layer in
[`CONTEXT_AND_RETRIEVAL_LAYER.md`](CONTEXT_AND_RETRIEVAL_LAYER.md).

The earlier retrieval absorption plan mixed near-term retrieval mechanics with
future Memory evolution. Current direction splits that work into two tracks:

- Track A: the Knowledge retrieval substrate — **implemented and superseded** by
  [`CONTEXT_AND_RETRIEVAL_LAYER.md`](CONTEXT_AND_RETRIEVAL_LAYER.md); the Phase-1-only
  scope below (no vector/rerank/synthesis) is historical — those have since shipped.
- Track B: later Memory quality and retrieval integration (still forward-looking).

The proposal gate, Space boundary, privacy boundary, and Runtime Context Memory
acquisition rules remain unchanged.

## Track A: Knowledge Retrieval Substrate (implemented; historical)

> Implemented and superseded — see
> [`CONTEXT_AND_RETRIEVAL_LAYER.md`](CONTEXT_AND_RETRIEVAL_LAYER.md) for current state.
> The "Track A does not …" list below captured the original Phase-1 (zero-LLM)
> scope; vector search, embeddings, rerankers, query rewrite, and LLM synthesis
> have since been added under their own boundaries. Kept for historical context.

Track A starts with Knowledge-owned objects only:

- `KnowledgeItem`
- `Note`
- `Source`

It uses agent-space-native mechanics for deterministic alias matching, normalized
text search, markdown/wikilink extraction, retrieval graph expansion, rank
fusion, and evidence/create-safety contracts.

Track A does not:

- Add an external retrieval runtime as a dependency.
- Make an external retrieval runtime the system of record.
- Index MemoryEntry rows.
- Change Memory write paths.
- Auto-inject Knowledge, Notes, Sources, or retrieval results into Runtime Context.
- Add vector search, pgvector, embeddings, rerankers, or LLM synthesis.
- Turn heuristic links into accepted canonical `ObjectRelation` rows.
- Revive the removed `context_sources` table.

The Knowledge retrieval projection is derived data. It can be rebuilt from
canonical Knowledge tables and must be live-revalidated before returning results.

## Track B: Later Memory Quality And Retrieval Integration

Memory integration is deferred until the Knowledge substrate proves the
mechanics and until a separate design covers:

- Memory ACL and sensitivity revalidation for every retrieval arm.
- `ContentReadTrace` logging requirements for cross-person candidate reads and context
  injection.
- SourceMonitoring interaction for duplicate/update suggestions.
- Proposal payload shape for retrieval evidence and duplicate detection.
- Runtime Context acquisition hard filters and planner token-budget behavior.
- Evaluation gates for ranking and leakage.

Any Memory-side implementation must preserve:

- Public Memory writes create proposals, not active `MemoryEntry` rows.
- Accepted Memory changes go through `ProposalApplyService` and the memory
  applier/writer path.
- Runtime Context remains the only runtime Memory acquisition authority.
- Every cross-person injected MemoryEntry is logged through ContentReadTrace;
  same-owner reads intentionally produce no privacy-audit row.
- Cross-space and private/restricted memory reads remain fail-closed unless a
  documented grant path explicitly applies.

## Future Memory Work

The useful context and retrieval ideas for later Memory work remain:

- Evidence contracts for retrieval results and proposal review.
- Create-safety signals for duplicate Memory proposals.
- Deterministic clustering to batch likely duplicates or thin entries.
- Weighted claims or confidence signals where they do not conflict with current
  status/version semantics.
- Lexical retrieval and graph expansion behind the existing Memory hard filter.
- Salience and recency as separate ranking axes.
- Synthesis/gap contracts for assistant answers, after Memory retrieval and
  citation rules are explicit.
- Scheduled maintenance that emits review candidates or proposals, never direct
  active Memory writes.

The privacy-first backend MVP for this scheduled/manual work is
[`MEMORY_MAINTENANCE.md`](MEMORY_MAINTENANCE.md). Current
implementation supports manual scans, durable full-scan jobs, scheduler
advancement, report artifacts, and review packets. Packet acceptance can
generate child pending `memory_archive` and `memory_update` proposals for
supported findings without writing canonical Memory directly.

Vector search, embeddings, rerankers, and LLM-backed synthesis are not part of
the first Knowledge retrieval implementation and should not be described as
current Memory behavior.

## Standing Risks

- Retrieval arms must never bypass hard filters or source monitoring.
- Derived indexes must never become source of truth.
- Ranking changes need focused evals before they affect runtime context.
- Automated maintenance must batch review pressure instead of creating one
  proposal per finding.
- Knowledge-to-Memory promotion remains a future explicit proposal flow.
