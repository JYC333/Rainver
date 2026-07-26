# Module: Memory

## Purpose
Scoped, long-term context for agents and users. Not raw data — curated, approved, versioned knowledge.

## Owns
- `MemoryEntry` schema and server memory read/proposal/apply repositories
- `MemoryReadTrace` (every read recorded)
- Memory write governance: public writes create Proposals, `ProposalApplyService` is the only durable write path
- Context memory providers and repositories
- `ContextBuilder` / context repository — assembles ContextPackage; hard-filters before ranking; resolves ContextAttachments; logs injected memory
- `ContextCompiler` — security-scans, budget-trims, writes vendor files to sandbox
- Memory-health evolution signals and `EvolutionExperience` records — proposal-gated lifecycle guidance, not direct writes
- `ContextSnapshot` — frozen audit record of run input; populated before adapter execution
- `MemoryCandidateValidator` — gates activity-sourced candidates before Proposal creation
- `MemoryProposalProducer` — creates Proposals from validated candidates
- `MemoryMaintenanceService` — owner-private Memory quality scans, report artifacts, and review packets
- `SourceMonitoringService` — gates semantic/policy proposal acceptance by source trust
- `server/src/modules/context/compiler.ts` and Project Folder `PathPolicy` — secret/injection scanning and path policy

## Key Models

```
MemoryEntry:
  id, space_id, owner_user_id, project_folder_id
  agent_id                          (nullable agent placement link)
  scope_type (system|space|user|project_folder|capability|agent)
  memory_type, memory_layer (episodic|semantic)
  namespace, title, content
  status (active|archived|proposed|rejected|superseded)
  visibility (`private` | `space_shared` | `selected_users`) and access level
  (`full` | `summary`)
  confidence, importance, version, tags
  created_from_proposal_id           (accepted proposal linkage)
  source_trust
  created_by, approved_by
  access_count, last_accessed_at, fitness_score

Proposal (memory_create | memory_update | memory_archive | memory_maintenance_packet | policy_change):
  id, space_id, project_folder_id, proposal_type, status, risk_level, urgency
  payload_json  — carries proposed content, provenance_entries, source evidence
  created_by_agent_id, created_by_run_id, created_by_user_id
  required_approver_role, created_at, decided_at

MemoryReadTrace:
  memory_id, user_id, agent_id, space_id, access_type, reason, created_at
```

## Memory Architecture Layers

- **L0** — `ActivityRecord`: raw event input; never active Memory.
- **L2/L3** — `MemoryEntry`: episodic and semantic long-term memory.
- **L4** — `Policy`: system rules; separate lifecycle, versioning, and enforcement.

## Main Flows

**Context assembly:**
1. `ContextBuilder.build(space_id, user_id, project_folder_id, attachments=[...])`
2. Hard-filters by space/scope/subject/visibility before ranking; logs all injected memory
3. Returns `ContextPackage`; populates `ContextSnapshot` before adapter execution
4. `ContextCompiler.compile()` → scans content → applies budget → writes CLAUDE.md plus Agent Persona Prompt sidecar (`SOUL.md`) to sandbox when applicable

**Public write → Proposal flow:**
1. `POST /memory` → `memory_create` Proposal (pending, not active MemoryEntry)
2. `PATCH /memory/{id}` → `memory_update` Proposal
3. `DELETE /memory/{id}` → `memory_archive` Proposal
4. User approves via `POST /api/v1/proposals/{id}/accept`
5. `ProposalApplyService.apply()` validates source trust, writes provenance links, then calls internal writer
6. `MemoryInternalWriter` creates/supersedes/archives the `MemoryEntry`

Accepted Memory provenance has one durable audit chain:
`provenance_links` attached to the resulting MemoryEntry. Proposal payload
`provenance_entries` are the pending/review-time source envelope before apply.
`MemoryEntry.created_from_proposal_id` is the accepted proposal linkage index.
Activity, Artifact, and other source provenance is not
duplicated onto MemoryEntry rows; read/audit code follows `provenance_links`.

**Activity → Proposal flow:**
1. `ActivityRecord` created with raw content and `source_trust`
2. `POST /api/v1/activity/{id}/consolidate` or `POST /api/v1/memory/consolidation/run` runs `ActivityConsolidationService`
3. Memory retrieval create-safety runs as a visible-set pre-dedupe check. Existing
   visible duplicates mark the Activity `processed` without creating another
   `memory_create` proposal.
4. Classifier → `MemoryCandidateValidator` (rejects cross-space, missing provenance, agent_inferred semantic, invalid scope)
5. `MemoryProposalProducer` creates reviewable Proposals with `provenance_entries`
6. Normal approval flow proceeds; `SourceMonitoringService` gates acceptance

## Invariants
- `space_id` required; `ContextBuilder` raises without it
- Public `POST /memory` does not create an active `MemoryEntry` — it creates a pending Proposal
- Public `PATCH /memory/{id}` does not mutate a `MemoryEntry` — it creates a pending Proposal
- Public `DELETE /memory/{id}` does not archive a `MemoryEntry` — it creates a pending Proposal
- `ProposalApplyService` is the only durable write path; accepted changes require `provenance_links`
- `agent_inferred`-only evidence cannot become active semantic memory or policy
- `untrusted_external` semantic/policy proposals require explicit user accept with source monitoring recorded
- Every memory read during context assembly logs to `MemoryReadTrace`; filtered-out memories are not logged
- Memory from space A never appears in a context built for space B
- Archived/superseded memory is excluded from context and list by default
- Executed runs must have a non-empty `ContextSnapshot`; snapshot population failure blocks execution
- All content passes security scanning before entering compiled context

## Relationship To Retrieval

Memory is a consumer of the shared retrieval engine
(`server/src/modules/retrieval/`; see
[CONTEXT_AND_RETRIEVAL_LAYER.md](../architecture/CONTEXT_AND_RETRIEVAL_LAYER.md) for
the engine/adapter boundary and the full retrieval + context-layer architecture),
scoped to two **current-space, human-facing** surfaces: advisory create-safety /
duplicate detection, and a retrieval-backed memory search. It is **not** a
ContextBuilder candidate source, and it does **not** do cross-space retrieval.
Those remain deferred (see
[MEMORY_EVOLUTION_PLAN.md](../architecture/MEMORY_EVOLUTION_PLAN.md) Track B); do
not widen this surface without a design that covers them explicitly. The
context and retrieval roadmap
([ROADMAP_AND_FUTURE_RISKS.md](../architecture/ROADMAP_AND_FUTURE_RISKS.md#retrieval-and-context-layer-stabilization))
keeps Memory a separate canonical domain with its own search/review/brief
surfaces: a shared retrieval engine must not collapse Memory into Knowledge or
silently promote between them.

### Memory retrieval search (`POST /api/v1/memory/retrieval/search`)

Human user-facing search over the caller's **current space only**
(`viewer = logged-in user`). Cross-space retrieval is fail-closed and not
implemented — including the "same user owns memory in another of their spaces"
case, which is a deliberate later extension point. The single read-access gate
is the memory adapter's `revalidate` (shared with create-safety): `canReadMemory`
+ summary-only redaction + **project-membership gating**. Only the rows actually
returned are logged to `memory_access_logs` (`search_hit`).

### Project-level access gate (`project_members`)

A memory row that carries a `project_id` is only retrievable by a viewer who can
access that project. The rule (`server/src/modules/memory/projectAccess.ts`
`canAccessProject`):

- **Personal space** (single-member): the sole member can access every project
  in it.
- **Shared (team/household) space**: the project `owner_user_id`, or any user
  with an `active` row in the new `project_members` table.
- A missing / deleted / cross-space project, or any non-member, **fails closed**.
- Memory with `project_id = null` is not project-gated (normal space/visibility
  rules apply).

The gate is enforced on every **user-facing** memory read surface:

- Retrieval surfaces (`POST /memory/retrieval/search`, `POST /memory/create-safety`)
  via the adapter `revalidate` (per-row `canAccessProject`).
- Legacy `PgMemoryReadRepository` read paths (`GET /memory`, `GET /memory/{id}`,
  `POST /memory/search`) via a batched `accessibleProjectIds` filter applied after
  `canReadMemory`, before pagination/logging.

Membership is managed through the projects module
(`server/src/modules/projects/`):

- `GET /api/v1/projects/{id}/members` — list (any space member).
- `POST /api/v1/projects/{id}/members` — add/upsert (`user_id`, `role`); requires
  the project owner or a space owner/admin, and the target must be an active
  member of the space.
- `DELETE /api/v1/projects/{id}/members/{userId}` — remove (same authority).

Proposal apply preserves this boundary: `ProposalApplyService` forwards
`proposals.project_id` into the memory applier, and `PgMemoryApplyRepository`
validates the project still exists in the proposal space before writing
`memory_entries.project_id`. A rejected/missing/cross-space project fails closed
with HTTP 422 semantics and does not create active memory.

**Runtime project cut.**
The per-run `ContextBuilder` retriever (`context/repository.ts retrieve` via
`prepareService`) now applies the project cut at the shared `hardFilterRows`
chokepoint: a run bound to project P sees P's memory (only if
`instructed_by_user_id` can access P) + project-free memory; a no-project run sees
project-free memory only. Chat/assistant context candidates
(`context/candidateRepository.ts`) use `canReadMemory` plus the same
`accessibleProjectIds` filter as the legacy memory read paths, so concrete
project memory can appear only for projects the viewer can access.
The chat path logs only final selected memory items, after budget/dedup, through
`PgContextSnapshotRepository` with `access_type = context_injection`.
`ContextDigest` (`context/digestService.ts`) is a shared cache, so Project Folder/agent
digests exclude `project_id IS NOT NULL` memory at generation time and revalidate
source ids with `project_id IS NULL` at consumption time — runtime memory
consumers are project-cut at the shared chokepoints (per-run retriever, chat
candidates, digest, project-linked evidence).

What landed (`server/src/modules/memory/retrievalAdapter.ts`):

- A `memory_entry` `RetrievalObjectType` and a Memory-owned
  `RetrievalDomainAdapter` registered in its **own** `memoryRetrievalRegistry`,
  separate from `knowledgeRetrievalRegistry` so the memory surface can never
  resolve Knowledge objects and vice versa.
- `revalidate` is the single read-access gate: it reuses `canReadMemory` plus
  `access_level=summary` content redaction plus project-membership gating (see "Project-
  level access gate" above). It runs with no Project Folder/system/template context,
  so Project Folder-scoped space_shared and system/template memories owned by other users fail
  closed; the proposer's own memories still match (owner check precedes the
  visibility switch), which is what duplicate detection needs. The derived
  `retrieval_*` projection is never trusted for read access.
- `POST /api/v1/memory/create-safety` (advisory; object_type must be
  `memory_entry`) returns `exists` / `probable_duplicate` / `unknown` with
  evidence. It is read-only and never blocks creation — the proposal write path
  is unchanged.
- Read-trace stays intact: only the matches actually returned are logged to
  `memory_access_logs` (`access_type = create_safety_hit`); candidates the engine
  over-fetched and then dropped during revalidation are never logged.
- Snippets come only from live-revalidated text, never the pre-revalidation
  projection chunk, so a summary-level memory shown to a non-owner returns a
  null snippet (content redaction is preserved).
- The projection is derived index data, kept fresh by a best-effort,
  SAVEPOINT-isolated reindex inside `acceptAndApply` (a projection failure never
  rolls back the accepted canonical write) and a space owner/admin-gated
  `POST /api/v1/memory/retrieval/reindex` for backfill. Memory create/update/
  archive stay proposal-gated; this work writes no `memory_entries`.

Memory context remains controlled by `ContextBuilder`, `MemoryReadAuth`,
`memory_access_logs`, `SourceMonitoringService`, and proposal-gated writes.
Knowledge retrieval results do not automatically enter Memory or runtime context.

## Memory Maintenance

`POST /api/v1/memory/maintenance/scan` runs an owner-private Memory health scan
for the authenticated user in the current space. It is separate from Knowledge
retrieval maintenance and uses the Memory read boundary:

- The scan is bounded by `limit` per page: by default it samples recent
  active/superseded/archived candidates ordered by `updated_at DESC, id DESC`;
  callers can opt into `scan_mode = full` and continue page-by-page with the
  opaque `next_cursor`. Durable maintenance jobs store that cursor in
  `memory_maintenance_jobs` and can be advanced by the job API or background
  scheduler.
- `canReadMemory` plus summary-only redaction.
- Project membership filtering through `accessibleProjectIds`.
- `highly_restricted`, `system`, and published snapshot rows are excluded.
- Only final finding rows are logged to `memory_access_logs` with
  `access_type = maintenance_scan`; filtered candidates are never logged or
  counted. Non-persistent scans still write this read log.
- The bounded SQL query may briefly load same-space rows before app-level
  visibility/project filtering, matching the existing Memory read model; such
  rows are not returned or persisted unless they pass the gates and contribute
  to findings.

The scan can persist a private `memory_maintenance_report` artifact and, with
`create_packet=true`, a private `memory_maintenance_packet` proposal. Accepting
that packet can create child pending `memory_archive` proposals for supported
duplicate findings and child pending `memory_update` proposals for supported
stale/thin/lifecycle/project/source/contradiction findings. It never writes
`memory_entries` directly; child proposals still require their own normal
review/apply step. Update child payloads carry maintenance provenance and mark
`requires_operator_edit` when the system cannot safely propose a complete
no-edit update.

## ContextDigest cache

`ContextDigest` is a versioned derived cache of approved Memory/Policy content. It is **not** Memory and **not** Policy.

- Supported `digest_type` values: `policy_bundle`, `project_folder`, `agent`.
- Digest content is rendered from active `MemoryEntry` + active `Policy` rows only. Unapproved proposal content is never included.
- Project Folder/agent memory digests are shared derived caches, so they include only cache-safe shared memory:
  Project Folder digests may include `space_shared` and Project Folder-scoped `space_shared` memory for that Project Folder;
  agent digests may include `space_shared` memory for that agent. User-specific or per-user gated
  content (`private`, `selected_users`, summary-level disclosure, and `highly_restricted` sensitivity) remains
  on the per-run retriever path.
- `ContextDigestService` generates/versions digests deterministically (no LLM required).
- Source hash versioning: if source IDs + version signals are unchanged, the existing digest is reused. If sources changed, old digest is marked `superseded` and a new version is created.
- `ContextCompiler` may use active digests in `stable_prefix`; `ContextSnapshot` records full source traceability.
- Consumption is fail-safe on read: a Project Folder/agent memory digest is only injected (and source-ref'd) when (1) the run's agent `readable_scopes` includes that scope — the digest is a derived view of that scope's memory, so it is gated by the same boundary as the direct retriever — **and** (2) it is `active` **and** (3) every memory id it claims still passes live revalidation for its scope (same space + scope, active, undeleted, shared, non-`highly_restricted`). A digest failing any check (out-of-scope, `dirty`, or any stale/ineligible claimed source) is dropped and that scope falls back to the direct retriever (memory) / direct active policies (`policy_bundle`). This prevents a pending change, a stale/tampered row, or a read-boundary bypass from leaking content into the prompt.
- Generation locks the Project Folder/agent scope row `FOR UPDATE` so it cannot be archived between the active-scope check and the digest insert (serializes against `archive`, which disables digests in the same transaction).
- Generation **and** dirty-marking take the same per-digest `pg_advisory_xact_lock` key (`policy_bundle:<space>` / `project_folder:<space>:<id>` / `agent:<space>:<id>`). Without a shared lock, a refresh that read stale sources could flip a concurrently-marked-dirty digest back to `active` (its `source_hash` still matching the stale read) and resurface it as injectable.
- Context preparation records `memory_access_logs` for digest source memory that is injected through a digest but was not already logged by the per-run retriever.
- Digest can be deleted and regenerated. Digest does not create Proposal.
- Personal Radius / external sources are out of scope.

### Dirty tracking
`ProposalApplyService` marks affected digests `dirty` after accepted proposals:
- `memory_create/update/archive` → marks `project_folder` and/or `agent` digest dirty based on the memory's scope.
- `policy_change` → marks only the `policy_bundle` digest dirty. Project Folder/agent digests are memory-only and never embed policy content, so a policy change does not dirty them (invalidating them would just recompute an identical memory hash). Scoped policies are still surfaced per-run at consumption time via `loadDigestBundle`.

## Related Files
- `.agent/architecture/MEMORY_MAINTENANCE.md`
- `server/src/modules/memory/`
- `server/src/modules/proposals/applyService.ts` (proposal-owned orchestration; memory owns registered appliers)
- `server/src/modules/context/`
- `server/src/modules/runs/`
- `server/migrations/`
- `packages/protocol/src/`

## Related Decisions
- [0003-memory-proposal-flow.md](../decisions/0003-memory-proposal-flow.md)
- [0004-context-wrapper.md](../decisions/0004-context-wrapper.md)
