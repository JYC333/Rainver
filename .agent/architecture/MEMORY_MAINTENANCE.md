# Memory Maintenance Current State

Status: backend scan, review packets, durable jobs/scheduler, and the scan UI
implemented. This document is current-state architecture and must track code
facts.

Memory maintenance is separate from Knowledge retrieval maintenance. Memory can
carry private, selected-user, summary-only, restricted, highly restricted,
system, template, project-scoped, and per-user content. The default implemented
surface is therefore a private review path initiated by a space owner/admin.
`retrieval.space.settings` `context_ops_scan_mode = members` additionally permits
active members/reviewers to initiate their own scans. A caller may explicitly
ask for a shared `space_ops` report/packet only when the Space Context Ops review
setting allows that reviewer; this does not scan other users' private Memory,
and a `space_ops` scan also drops `private` and `selected_users` rows, the
caller's own included (`excludePersonalVisibility`).

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
- Report artifacts are opened through the generic Artifacts pages
  (`apps/web/src/modules/artifacts/`)

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

The route (`server/src/modules/contentAccess/routes.ts`, `listForOwner` in
`contentAccess/audit.ts`) answers only the Memory's owner, then pages that
resource's `content_access_logs` rows by `offset`/`limit`. The response returns
`items`, `limit`, `offset`, `returned`, and `has_more`. It returns only audit
metadata: log id, resource ids, owner and viewer ids plus the viewer's display
name, agent/run pointers, access type, reason, and timestamp. It does not
select or return Memory content or snippets.

## Web Surface

The Memory page exposes:

- a Memory Maintenance panel for running the bounded scan, choosing private or
  allowed `space_ops` review scope, creating a persisted report, optionally
  creating a review packet, carrying the active page-level `project_id` filter
  into the scan, switching between `recent` and cursor-paginated `full` scan
  mode, continuing from `next_cursor`, opening the resulting artifact/proposal,
  generating a Claim Candidate Packet from the persisted report artifact, and
  previewing the first 8 findings before opening the full report artifact

The web API client also exposes durable job create/get/run helpers. There is no
first-class job console on the Memory page yet; the page's visible product
surface remains manual scan/cursor continuation.

The Memory page reads Space retrieval settings and keeps `space_ops` review
scope unavailable when `context_ops_review_mode = private_only`, so the UI fails
early instead of relying only on the route's 403. Context Ops summary reports
`memory_provenance.inspector_available = true` and links to the Memory page;
per-Memory access logs are read through the Content Access control
(`apps/web/src/components/ContentAccessControl.tsx`).

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
   `completed` when the cursor is exhausted. A page cut short by `max_findings`
   always leaves a cursor, so a truncated scan is never `completed`.
5. A failing page rolls back to its savepoint and marks the job `failed` with a
   bounded error message, leaving the cursor where the page started and
   `completed_at` unset. Running the job again resumes from that cursor; the
   scheduler does not pick failed jobs up on its own. Each page is one
   transaction under the job row lock, so a re-run after an interruption
   repeats the page rather than duplicating its report or packet.

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
- `scope_type <> 'agent'` (Agent Memory is excluded in the query, so it does
  not consume the scan window)
- `status = 'active'` (a superseded or archived version is the history of an
  entry, not something to repair)
- optional exact `project_id`
- optional cursor boundary over `(updated_at DESC, id DESC)`
- ordered by `updated_at DESC, id DESC`
- limited by request `limit`

The response counters mean:

- `candidate_limit`: requested SQL candidate limit.
- `candidates_examined`: visible rows examined after Memory and project filters
  within that bounded SQL window.
- `scanned`: equal to `candidates_examined`, so other maintenance report shapes
  read the same counter.

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
`source_policy_drift`, and `contradiction`. Every finding carries
`cluster_key`/`cluster_label` for batched review grouping and a
`proposed_action`, which is `null` for a hint. `counts` are computed from the
findings the page returns.

`max_findings` caps a page without losing what lies beyond it. In a full scan,
when a window's findings exceed the cap, the page reports the longest leading
run of entries whose findings all fit and the cursor resumes right after it,
so the remaining entries are read again on the next page. If the first entry
alone has more findings than the cap, the page reports the first `max_findings`
of them and the cursor stays on that entry with a `finding_offset`; the next
page reports the rest of that entry's findings, reading it by id (an entry that
changed or left the caller's view since is skipped, because its earlier
findings no longer describe it). `truncated=true` means the page was cut short.
A recent scan has no cursor; it reports the first `max_findings` findings and
`truncated=true`.

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
  - `scope_type = agent`
- for `review_scope = space_ops`, exclusion of `private` and `selected_users`
  visibility

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
- `source_policy_drift`
- `contradiction`

A finding names a real problem or carries a hint. Age and short content are
hints: visible on the report, with `proposed_action = null`, and never a task
for anyone. A version chain is not drift — an active head points at the
version it replaced, and every version keeps its root — so the scan does not
report it.

Current behavior:

- `duplicate`: active visible memories sharing a normalized title, or sharing a
  readable normalized content prefix when title is absent, full content is
  readable, and the normalized content is at least 24 characters. The content key
  uses the first 120 normalized characters. Proposed action:
  `memory_archive` for duplicate targets after the first visible memory.
- `stale`: active visible memories whose `last_confirmed_at`, falling back to
  `updated_at`, is older than `stale_after_days`. A hint: no proposed action.
- `thin`: active visible memories with full readable content shorter than
  `thin_content_chars`. A hint: no proposed action.
- `source_policy_drift`: active visible external-trust memories without a
  source pointer for source-policy review. Proposed action: `memory_update`
  with `maintenance_action = attach_or_review_external_source`.
- `contradiction`: active visible memories with the same normalized title and a
  deterministic negation disagreement signal. This is low-confidence advisory
  output and does not include content. Proposed action: `memory_update` on the
  affirmative memory with `maintenance_action = review_contradiction` and the
  disagreeing visible memory id in `related_memory_ids`.

`proposed_action` is typed by `MemoryMaintenanceProposedActionSchema`: a
`memory_archive` with its targets, or a `memory_update` naming one of the two
actions above. Every update is a person's revision of the content (see Packet
apply below).

Findings include only:

- `object_type = memory_entry`
- visible memory id
- visible title or `null`
- reason string
- cluster key/label for grouped review
- optional `confidence_tier`
- `proposed_action`, typed, or `null` for a hint

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
- creates child pending `memory_archive` proposals for duplicate findings and
  child pending `memory_update` proposals for source-policy and contradiction
  findings; a hint (`proposed_action = null`) creates nothing
- child update payloads carry `operation = update`, `target_memory_id`,
  `maintenance_action`, related visible memory ids where relevant,
  `requires_operator_edit = true`, and one provenance entry of the registered
  `proposal` source type naming the packet, with the report artifact id, the
  finding kind and its reason as evidence. That entry carries no trust: it
  says why the entry is being revised, not what the revision rests on
- records `generated_child_proposal_ids` and
  `generated_child_proposal_count` on the accepted packet
- performs no canonical Memory writes

A child update is a person's revision of the entry, never an accept of the
entry as it was:

- The canonical applier refuses a `memory_update` with a `maintenance_action`
  or `requires_operator_edit` until it carries an `operator_edit`, answering
  `409 memory_operator_edit_required`, and refuses an unknown action. The check
  runs before the source-monitoring gate, so that is the reason given.
- `POST /api/v1/memory/proposals/:proposalId/revision`
  (`MemoryProposalRevisionRequestSchema`: `content`, optional `title`) writes
  the revision into the pending child. Only someone who decides what the entry
  says may write it — its owner, or a Project writer for Project Memory — and
  someone who cannot read the entry gets a 404. The revision records
  `operator_edit` (who, when) and appends a `user_confirmation` provenance
  entry: the person wrote the text, which is the basis it now rests on.
  Clicking accept on anything else never adds a confirmation.
- The proposal wire shape exposes `target_memory_id` and `operator_revision`,
  and the proposal page offers the editor, starting from the entry's current
  text, with Accept disabled until a revision is saved.
- Accepting any update that would leave the entry exactly as it is — content,
  title, placement, reach, sensitivity, subject, layer and grants — writes no
  version; the proposal is accepted with `no_change = true` and
  `resulting_memory_id` naming the unchanged entry.

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
create pending child Memory archive/update proposals, which require their
own proposal review/apply step before any canonical Memory mutation.

## Tests

Focused coverage:

- `server/test/memoryMaintenance.test.ts`
- `server/test/memoryMaintenanceArtifacts.test.ts`
- `server/test/memoryMaintenanceJobs.test.ts`
- `server/test/memoryMaintenanceRoutes.test.ts`
- `server/test/memoryMaintenanceDb.test.ts`
- `server/test/memoryMaintenanceRevisionDb.test.ts`
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
