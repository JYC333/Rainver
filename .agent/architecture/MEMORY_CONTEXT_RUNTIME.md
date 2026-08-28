# Memory / Runtime Context

Status: implemented current state after the Runtime Context clean cutover.

This document describes the boundary between governed Memory and the Runtime
Context invocation engine. Canonical Memory is durable product state; Runtime
Context is an invocation-scoped acquisition, planning, delivery, and continuity
authority. Neither may silently become the other.

## 1. Memory authority

`memory_entries` contains scoped Memory. It is written only through the
proposal apply service, by one of two routes
([ADR 0003](../decisions/0003-memory-proposal-flow.md)): a proposal a person
approved, or an Agent's own bounded write in a person's turn (`applyDirect` —
private, normal-sensitivity, about the acting person, always a new version
carrying its run, session and rationale). Public routes, Runs, retrievers,
checkpoint extractors and adapters still cannot write around it, and a
checkpoint promoting content into Memory is a write under ADR 0003 like any
other. Note for anyone hardening this path: the direct route deliberately does
not run `evaluateMemoryProposal`, whose trust rule would reject every
agent-authored write; what stands in for it is §2's bounds and the fact that
the write is reversible in one action.

Every Memory read revalidates:

- active Space membership and exact `space_id`;
- `deleted_at IS NULL` and `status = active`;
- user or Project scope, ownership, visibility, grants, and Project membership;
- summary-only Personal Memory grants before content leaves the domain.

Memory search and retrieval remain read-only candidate authorities. Their
results can enter an invocation only through Runtime Context acquisition and
live Delivery authorization. Runtime Context checkpoints do not promote content
to Memory; promotion still requires a proposal and approval.

## 2. Runtime Context authority

`server/src/modules/runtimeContext/` is the only context assembly authority for
managed Runs, direct Chat, Room turns, and local CLI calls. For every physical
invocation, `RuntimeContextInvocationGateway`:

1. loads the immutable execution-control snapshot and locked Run authority;
2. resolves/version-binds Work Context Setup;
3. acquires typed items from canonical Message, Project, Run, checkpoint,
   Retrieval, and other owning-domain ports;
4. reauthorizes the instructing user, Space, scope, refs, and rendered content;
5. normalizes, orders, deduplicates, and budgets through the planner;
6. persists one accepted Invocation Delivery and a safe Invocation Snapshot;
7. requires adapter acknowledgement and invocation finalization.

Adapters render the accepted Delivery without fetching, reordering, rebudgeting,
or caching additional model-visible context. Tool loops create a distinct
Delivery for every physical provider request. Direct Chat and Room routes only
persist canonical messages/routing facts and queue work; they do not build
prompt bundles.

## 3. Typed items and precedence

Acquisition produces protocol `ContextItem` values with canonical refs,
provenance, authority, sensitivity, freshness, and token estimates. The planner
applies the ADR 0014 precedence model and deterministic window budgeting. A
lower-authority item cannot displace locked system/delegated instructions, and
duplicate canonical refs collapse before rendering. Retrieval remains a
candidate source and does not become an instruction authority.

Taint is derived from accepted inputs and remains an output-publication ceiling.
Cross-owner inputs therefore keep selected-user output restrictions and require
the existing governed egress-review path before wider publication.

## 4. Delivery and audit

An Invocation Delivery binds the planned envelope to invocation id, adapter,
provider/model identity, execution-control snapshot, renderer version, and
Usage source. A safe Invocation Snapshot stores hashes, refs, counts, decisions,
acknowledgement, terminal state, and other non-secret evidence. Raw replay, when
explicitly permitted, is an encrypted Sealed Payload with separate read
authorization; it is never returned by normal Run/trace reads.

The Delivery's managed-provider output limit is the planner's actual reserved
output-token budget, not a separately rediscovered default or nullable caller
override. The adapter and physical Provider request preserve that bound.

Delivery references are single-use at the physical-call boundary. Runtime Host
dispatch records a full-request fingerprint, and Usage uses unique response
suffixes while retaining Delivery audit refs.

## 5. Context Events and checkpoints

Runtime Context continuity is append-only and scope-sequenced. Canonical bodies
remain in Message, Run, Artifact, Run Event, Invocation Snapshot, or the owning
product table; Context Events store ordered refs and typed continuity facts.

- Ingress records sequence gaps rather than inventing missing history.
- Terminal events create deterministic Micro Checkpoints.
- Semantic extraction runs outside the persistence transaction and may publish
  only after revalidating the selected head and every canonical ref. Ordinary
  terminal events alone do not invoke the semantic provider; threshold and
  material-change triggers remain conditional.
- Immutable corrections supersede invalid semantic checkpoints without
  rewriting prior events. Authenticated clients submit corrections through the
  active Work Context's checkpoint-correction command route; the mutation
  transaction takes the Work Context version advisory lock, then revalidates
  and locks the active scope and Project ACL authority.
- Room conversation continuity combines the active append-only Room summary
  (2,000-token budget) with only the uncaptured canonical message tail
  (6,000-token budget) through the exact current message. The summary cursor is
  exclusive, so ranges cannot overlap; the canonical transcript remains the
  source of truth and is always available through paged history. Before an
  active summary exists, the same complete-message assembler is used rather
  than a separate fixed-count/truncating window. Prior messages larger than the
  recent budget are omitted; only the triggering message is preserved intact.
  Non-Room continuity retains the Semantic Checkpoint plus its bounded message
  tail.
- Room summaries are asynchronous API tasks charged to the active Room owner.
  Scheduling waits for a 6,000-token raw uncompacted-prefix threshold and the
  worker rechecks that the owner can still write the bound Project. The worker
  accepts any eligible owner-usable API provider (including an eligible Space
  grant), records tokenizer and prompt/schema provenance, and uses a 12,000
  token source budget. Missing API configuration yields a visible
  `waiting_provider` freshness state and never blocks message persistence or
  conversation use. Retry failures use capped exponential backoff with jitter,
  distinguish `retry_wait` from terminal `failed`, and never advance coverage
  on malformed provider output.
- CLI continuity stores an acknowledged cursor and rotates its private vendor
  session when scope, generation, cursor, replay authority, or a bounded delta
  overflow is detected. Overflow rotation bootstraps from the latest authorized
  checkpoint and transfers the execution lease to the replacement binding. A
  successful bootstrap/delta phase advances that cursor before the current-user
  turn is sent, while the whole invocation Snapshot remains draft until its
  terminal acknowledgement.

## 6. Policy and transaction boundaries

Execution-control Policy, credential, egress, tool, and budget decisions are
snapshotted before context preparation. Runtime Context authorizes against that
snapshot and live visibility; it does not independently reinterpret those
authorities. Delivery/snapshot persistence, acknowledgement, finalization, and
continuity writes use short transactions. Provider and CLI calls occur outside
database transactions.

Database-backed behavior tests use the shared real PostgreSQL fixture. The
legacy absence test additionally scans production, schema, protocol, migration,
and active-test roots so retired Context Snapshot/Compiler/Digest and vendor-file
paths cannot return unnoticed.

## 7. Retired architecture

The clean cutover deleted the Context Builder/Compiler/Prepare service, Context
Profiles and routing manifests, Context Snapshots and Context Digests, manual
context artifact attachment/revocation UI and APIs, route-owned chat bundles,
session-summary caches, and vendor context-file rendering. There is no dual-read,
dual-write, fallback, or compatibility alias. ADR 0014 remains the design record;
Git history retains the clean-cutover implementation and review evidence.
