# Memory Maintenance Current State

Status: backend scan, review packets, durable jobs/scheduler, and first scan UI
implemented. This document is current-state architecture and must track code
facts.

Memory maintenance is separate from Knowledge retrieval maintenance. Memory can
carry private, selected-user, summary-only, restricted, highly restricted,
system, template, project-scoped, and per-user content. The default implemented
surface is therefore a private review path initiated by a space owner/admin.
`retrieval.space.settings` `context_ops_scan_mode = members` additionally permits
active members/reviewers to initiate their own scans. A caller may explicitly
ask for a shared `space_ops` report/packet only when the Space Context Ops review
setting allows that reviewer; this does not scan other users' private Memory.

## Source Of Truth

Primary code paths:

- Route: `server/src/modules/memory/routes.ts`
- Scan service: `server/src/modules/memory/maintenance.ts`
- Durable job runner: `server/src/modules/memory/maintenanceJobs.ts`
- Artifact and packet helpers:
  `server/src/modules/memory/maintenanceArtifacts.ts`
- Scheduler wiring: `server/src/modules/scheduler/backgroundServices.ts`
- Scheduler config: `server/src/config.ts`
- Read tracing: `server/src/modules/memory/repository.ts`
- Memory auth: `server/src/modules/memory/memoryReadAuth.ts`
- Project gate: `server/src/modules/memory/projectAccess.ts`
- Protocol schema: `packages/protocol/src/memorySessions.ts`
- Proposal result schema: `packages/protocol/src/proposals.ts`
- Policy registry: `packages/protocol/src/policy.ts`
- Server policy risk mapping: `server/src/modules/policy/gateway.ts`
- Proposal applier registration:
  `server/src/modules/proposals/applierRegistry.ts`
- Web API client and UI:
  `apps/web/src/api/client.ts`, `apps/web/src/modules/memory/MemoriesPage.tsx`
- Artifact rendering:
  `apps/web/src/modules/artifacts/ArtifactRendererRegistry.tsx`

## HTTP Surface

Implemented endpoints:

`POST /api/v1/memory/maintenance/scan`

`POST /api/v1/memory/maintenance/jobs`

`GET /api/v1/memory/maintenance/jobs/:jobId`

`POST /api/v1/memory/maintenance/jobs/:jobId/run`

The route resolves the authenticated user and current space through the normal
Memory route identity path. It requires `SERVER_DATABASE_URL`; without it the
route returns 502. Scan initiation is gated by
`retrieval.space.settings` `context_ops_scan_mode`: `admins` permits owners/admins;
`members` also permits active members/reviewers. This gate is separate from
`context_ops_review_mode`, which controls shared packet review.

Request schema (`MemoryMaintenanceScanRequestSchema`):

- `persist_report`: boolean, default `true`
- `create_packet`: boolean, default `false`
- `limit`: positive integer, default `500`, max `1000`
- `stale_after_days`: positive integer, default `180`, max `3650`
- `thin_content_chars`: positive integer, default `80`, max `1000`
- `max_findings`: positive integer, default `100`, max `200`
- `review_scope`: `private` or `space_ops`, default `private`
- `project_id`: optional project filter for project-scoped maintenance scans
- `scan_mode`: `recent` or `full`, default `recent`
- `cursor`: optional opaque cursor for continuing `scan_mode = full`
- `job_id`: optional report correlation id used by durable jobs

`create_packet=true` with `persist_report=false` is rejected with 422 because
packets point at a persisted report artifact. `review_scope=space_ops` is
rejected unless `retrieval.space.settings` `context_ops_review_mode` allows the
current reviewer.

Response schema (`MemoryMaintenanceReportSchema`) contains findings, counts,
bounded-scan counters, `truncated`, optional `artifact_id`, optional
`proposal_id`, `scan_mode`, optional `next_cursor`, optional `job_id`,
optional `job_status`, and `access_safety`.

Durable job create (`MemoryMaintenanceJobCreateRequestSchema`) accepts the same
options as the scan route except `cursor` and `job_id`; `scan_mode` is fixed to
`full`. Creating a job requires the same Context Ops scan initiation authority as
manual scan. `review_scope=space_ops` additionally requires Context Ops review
permission, matching manual scan.

Job responses (`MemoryMaintenanceJobSchema`) expose only job metadata: id,
space/user pointers, `status`, `review_scope`, normalized scan options, stored
cursor, accumulated scanned/finding totals, last report/proposal ids, bounded
error message, and timestamps. `GET` returns jobs owned by the caller, or
`space_ops` jobs visible to a reviewer allowed by Context Ops review settings.
`POST .../:jobId/run` advances one page inside a DB transaction and returns the
updated job plus the page report, or `report = null` when the job was already
terminal.

Memory has no domain-wide access-log inspector. Owners inspect cross-person
reads on an individual Memory through the common Content Access control, backed
by `GET /api/v1/content-access/memory/:resourceId/access-logs`.

The route joins each log to `memory_entries`, applies `canReadMemory` with the
optional Project Folder context, applies the project gate via `accessibleProjectIds`,
then slices the currently visible list by `offset`/`limit`. The response returns
`items`, `limit`, `offset`, `returned`, and `has_more`. It returns only audit
metadata: log id, memory id/title/scope/visibility/project id, user/agent/run
pointers, access type, reason, and timestamp. It does not select or return
Memory content or snippets. Rows hidden by current Memory policy are omitted
instead of surfaced as blocked entries.

## Web Surface

The Memory page exposes:

- a Memory Maintenance panel for running the bounded scan, choosing private or
  allowed `space_ops` review scope, creating a persisted report, optionally
  creating a review packet, carrying the active page-level `project_id` filter
  into the scan, switching between `recent` and cursor-paginated `full` scan
  mode, continuing from `next_cursor`, opening the resulting artifact/proposal,
  generating a Claim Candidate Packet from the persisted report artifact, and
  previewing the first 8 findings before opening the full report artifact
- an Access Log Inspector for recent currently readable Memory access logs,
  filterable by `access_type`, Project Folder context, and the active page-level
  `project_id`, with offset-based previous/next controls

The web API client also exposes durable job create/get/run helpers. There is no
first-class job console on the Memory page yet; the page's visible product
surface remains manual scan/cursor continuation plus the access-log inspector.

The Memory page reads Space retrieval settings and keeps `space_ops` review
scope unavailable when `context_ops_review_mode = private_only`, so the UI fails
early instead of relying only on the route's 403. Context Ops summary reports
`memory_provenance.inspector_available = true` and links to the Memory page
inspector, but the inspector itself lives on the Memory page so it can use
Memory-specific readability and project-gate expectations.

## Route Flow

When `persist_report=true`:

1. Open one DB transaction with `withDbTransaction`.
2. Run `MemoryMaintenanceService.scan`.
3. Insert a `memory_maintenance_report` artifact. It is private by default, or
   `space_shared` only when `review_scope=space_ops` is explicitly requested and
   allowed.
4. Optionally insert a `memory_maintenance_packet` proposal when
   `create_packet=true`, with the same review scope as the report.
5. Write `maintenance_scan` memory access logs for final contributing memories.
6. Commit and return the report plus `artifact_id` and optional `proposal_id`.

If any step fails, the transaction rolls back artifact, proposal, read logs, and
memory `access_count` updates together.

When `persist_report=false`, the scan is not artifacted and no packet can be
created, but final contributing memories are still logged with
`access_type = maintenance_scan`.

Durable jobs wrap the same scan flow:

1. `POST /memory/maintenance/jobs` inserts a `memory_maintenance_jobs` row with
   normalized full-scan options, `status = pending`, no cursor, and zero totals.
2. `POST /memory/maintenance/jobs/:jobId/run` locks the visible job row
   `FOR UPDATE` inside a DB transaction, marks it `running`, and runs one
   `scan_mode = full` page as the job owner.
3. If configured, the run persists a report artifact and optional packet for
   that page, then records `maintenance_scan` read logs for contributing
   memories.
4. The job stores the next visible cursor, accumulated scanned/finding totals,
   last report/proposal ids, and returns to `pending` when more pages remain or
   `completed` when the cursor is exhausted.
5. Failures mark the job `failed` with a bounded error message and return
   `report = null`; failed jobs are terminal until an operator creates a new job.

The background service registers `memory_maintenance_scheduler` when
`SERVER_DATABASE_URL` exists and
`SERVER_MEMORY_MAINTENANCE_SCHEDULER_ENABLED` is enabled. It periodically
advances due `pending`/`running` jobs up to
`SERVER_MEMORY_MAINTENANCE_SCHEDULER_BATCH_LIMIT` in the same transactional
runner used by manual job execution.

## Scan Semantics

The default scan is a bounded recent-update sample. Callers can opt into
`scan_mode = full`, which uses the same ordered window plus a stateless cursor
to continue the scan across pages.

`MemoryMaintenanceService.loadCandidates` selects from `memory_entries`:

- current `space_id`
- `deleted_at IS NULL`
- `status IN ('active', 'superseded', 'archived')`
- optional exact `project_id`
- optional cursor boundary over `(updated_at DESC, id DESC)`
- ordered by `updated_at DESC, id DESC`
- limited by request `limit`

The response counters mean:

- `candidate_limit`: requested SQL candidate limit.
- `candidates_examined`: visible rows examined after Memory and project filters
  within that bounded SQL window.
- `scanned`: currently equal to `candidates_examined`; kept for compatibility
  with other maintenance report shapes.

Older memories outside the bounded recent-update window can be missed unless the
caller uses `scan_mode = full`. Full scan is page-at-a-time at the service
layer: the stateless route returns `next_cursor`, while durable jobs store that
cursor in `memory_maintenance_jobs.cursor` and let manual job run or the
background scheduler continue it. The cursor is derived from the last visible row
in the page and `access_safety.cursor_uses_visible_boundary` is set so hidden
filtered rows are not named or counted through cursor metadata. When continuing
from a visible cursor, the service may internally advance across hidden-only
candidate windows using a non-returned physical boundary so the external cursor
still avoids exposing hidden ids while the scan can reach older visible rows.

Findings are generated in this order: duplicate, stale, thin,
`lifecycle_drift`, `archived_state_drift`, `project_drift`,
`source_policy_drift`, and `contradiction`. Every finding carries
`cluster_key`/`cluster_label` for batched review grouping and may carry a
bounded `proposed_action`. The combined finding list is capped to
`max_findings`; `counts` are computed from the capped list. `truncated=true`
means more findings existed before capping.

## Access Boundary

The scan actor is always the authenticated user. The service applies normal
Memory read authorization and additional maintenance exclusions before a row can
contribute to findings.

Implemented gates:

- `canReadMemory(row, { userId, spaceId })`
- `summaryOnlyRedactContent(row, userId)`
- `accessibleProjectIds` for rows with `project_id`
- explicit maintenance exclusion of:
  - `sensitivity_level = highly_restricted`

For `summary_only` rows:

- Owner scans may inspect full content for duplicate/thin checks.
- Non-owner scans do not inspect full content and cannot get content-prefix
  duplicate or thin findings from that row.
- Reports record `access_safety.summary_access_full_content_used` when owner-only
  summary content was used internally.

The bounded SQL query can load same-space rows into server memory before
application-level filtering, matching the existing Memory read model. Filtered
rows are not returned, logged, counted, named, or persisted.

## Finding Kinds

Protocol enum:

- `duplicate`
- `stale`
- `thin`
- `lifecycle_drift`
- `archived_state_drift`
- `project_drift`
- `source_policy_drift`
- `contradiction`

Current behavior:

- `duplicate`: active visible memories sharing a normalized title, or sharing a
  readable normalized content prefix when title is absent, full content is
  readable, and the normalized content is at least 24 characters. The content key
  uses the first 120 normalized characters. Proposed action:
  `memory_archive` for duplicate targets after the first visible memory.
- `stale`: active visible memories whose `last_confirmed_at`, falling back to
  `updated_at`, is older than `stale_after_days`. Proposed action:
  `memory_update` with `maintenance_action = reconfirm_stale_memory`.
- `thin`: active visible memories with full readable content shorter than
  `thin_content_chars`. Proposed action: `memory_update` with
  `maintenance_action = enrich_thin_memory`.
- `lifecycle_drift`: visible superseded memories without
  `supersedes_memory_id`, or active memories that still carry
  `supersedes_memory_id`. Proposed action: `memory_update`, with
  `requires_operator_edit = true` for missing superseding-memory review.
- `archived_state_drift`: visible archived memories that still carry lifecycle
  pointers (`root_memory_id` or `supersedes_memory_id`). Proposed action:
  `memory_update` with `requires_operator_edit = true`.
- `project_drift`: active visible memories linked to a Project but not scoped as
  project memory. Proposed action: `memory_update` to align target scope and
  project id.
- `source_policy_drift`: active visible external-trust memories without a
  source pointer for source-policy review. Proposed action: `memory_update` with
  `requires_operator_edit = true`.
- `contradiction`: active visible memories with the same normalized title and a
  deterministic negation disagreement signal. This is low-confidence advisory
  output and does not include content. Proposed action: `memory_update` on the
  affirmative memory, with the disagreeing visible memory id listed in
  `related_memory_ids` and `requires_operator_edit = true`.

Findings include only:

- `object_type = memory_entry`
- visible memory id
- visible title or `null`
- reason string
- cluster key/label for grouped review
- optional `confidence_tier`
- optional structured `proposed_action`

Findings do not include raw `content`, snippets, hidden ids, hidden titles, or
dropped-row counts.

## Report Artifact

Artifact type: `memory_maintenance_report`

Inserted by `persistMemoryMaintenanceReportArtifact` with:

- `visibility = private` by default, or `space_shared` for explicit
  `review_scope = space_ops`
- `owner_user_id = scanner user`
- `artifact_type = memory_maintenance_report`
- `canonical_format = memory_maintenance_report.v1`
- `mime_type = application/json; charset=utf-8`
- `trust_level = medium`
- JSON `content` and `metadata_json` containing:
  - findings
  - counts
  - `candidate_limit`
  - `candidates_examined`
  - `scanned`
  - `truncated`
  - `scan_mode`
  - `next_cursor`
  - job correlation fields when produced by a durable job
  - scan options
  - `review_scope`
  - access-safety metadata
  - retention metadata

Raw Memory content and snippets are not stored in the artifact.

## Review Packet

Proposal type: `memory_maintenance_packet`

Created by `createMemoryMaintenanceProposalPacket` with:

- `status = pending`
- `risk_level = medium`
- `urgency = normal`
- `visibility = private` by default, or `space_shared` for explicit
  `review_scope = space_ops`
- `created_by_user_id = scanner user`
- payload `operation = memory_maintenance_packet`
- payload `target_scope = memory`
- payload `target_namespace = memory.maintenance`
- payload `review_scope`
- payload `report_artifact_id`
- copied findings/counts/bounded-scan counters
- copied `scan_mode` and `next_cursor`
- `canonical_write_performed = false`

Packet acceptance is implemented by the proposal applier registered in
`registerMemoryMaintenanceProposalAppliers`.

Accepting a packet:

- requires the accepting user to match `created_by_user_id` for private packets
- allows a non-creator only when the proposal is `visibility = space_shared`,
  payload `review_scope = space_ops`, and
  `retrieval.space.settings` `context_ops_review_mode` permits that role
- updates the proposal to `status = accepted`
- records `reviewed_at`, `reviewed_by`, `accepted_by_user_id`, and
  `accepted_at`
- returns `result_type = memory_maintenance_packet`
- creates child pending `memory_archive` proposals for supported duplicate
  findings and child pending `memory_update` proposals for supported stale,
  thin, lifecycle, archived-state, project-scope, source-policy, and
  contradiction findings
- child update payloads carry `operation = update`, `target_memory_id`, optional
  `target_scope`/`project_id`, `maintenance_action`, related visible memory ids
  where relevant, provenance back to the maintenance packet/report artifact, and
  `requires_operator_edit` when the system cannot safely propose a complete
  no-edit update
- records `generated_child_proposal_ids` and
  `generated_child_proposal_count` on the accepted packet
- performs no canonical Memory writes

A space admin cannot accept another user's private maintenance packet through
the current applier. Admin/member review applies only to explicit shared
`space_ops` packets and does not weaken private creator-only packets.

## Policy Wiring

`memory_maintenance_packet` is registered as a proposal action with medium risk:

- Protocol action registry: `packages/protocol/src/policy.ts`
- Server risk table: `server/src/modules/policy/gateway.ts`
- Proposal type/result schema: `packages/protocol/src/proposals.ts`
- Applier registry: `server/src/modules/proposals/applierRegistry.ts`

It is enforced through the normal `proposal.apply` path. Accepting the packet
does not bypass Memory write governance: it only acknowledges the packet and may
create pending child Memory archive/update proposals, which still require their
own normal proposal review/apply step before any canonical Memory mutation.

## Tests

Focused coverage:

- `server/test/memoryMaintenance.test.ts`
- `server/test/memoryMaintenanceArtifacts.test.ts`
- `server/test/memoryMaintenanceJobs.test.ts`
- `server/test/memoryMaintenanceRoutes.test.ts`
- `server/test/memoryMaintenanceDb.test.ts`
- `server/test/proposalApplierRegistry.test.ts`
- `server/test/policyDecisionCore.test.ts`
- `server/test/proposalsRoutes.test.ts`
- `packages/protocol/test/memorySessions.test.ts`
- `packages/protocol/test/proposals.test.ts`
- `packages/protocol/test/policy.test.ts`

The real Postgres test uses Testcontainers, applies `server/migrations`, and
covers the baseline schema behavior for selected-user grants, `summary`
access handling, `highly_restricted` exclusion, and transaction
rollback of artifacts, proposals, access logs, and `access_count`.

## Not Implemented

These are not part of the current Memory maintenance product slice:

- Delegated admin review of another user's private packet.
- LLM-backed contradiction classification beyond the deterministic negation
  signal.
- Claim-relation or direct Claim proposal generation from Memory contradiction
  findings; current contradiction handling produces a Memory update child
  proposal for operator review.
- A first-class web job console for durable Memory maintenance jobs. The API
  client can create/get/run jobs, but the Memory page still exposes manual scan
  and cursor continuation as its visible scan workflow.
- Automatic application of generated child archive/update proposals. Packet
  acceptance only creates child proposals; canonical Memory changes still require
  the normal proposal review/apply step.
- Durable cursor pagination for access-log inspection.
- Broader end-to-end frontend coverage for all managed-run artifact picker
  surfaces.
