# Module: Proposals

## Purpose
Approval workflow. Durable memory and code changes must go through a Proposal before taking effect. `ProposalApplyService` is the only normal durable write path.

## Owns
- `Proposal` model (generalized, any type)
- `ProposalApproval` — `egress_granting_user` approval gate and `action_grant` pre-authorization rows
- `Artifact` (persistent output of agent runs)
- `PgProposalApplyService` (`accept` / `acceptInTransaction` / `reject` / `approveEgressGrantingUser` / `rollback`) — runs the apply gate and dispatches through `ProposalApplierRegistry` to module-owned appliers
- Source-trust gating of memory acceptance lives in the memory applier path (`memory/sourceMonitoring.ts` gate functions), not in a proposals service
- `ConversationContinuationRegistry` (`proposals/continuationRegistry.ts`) — maps a resolved (accepted/rejected) Proposal to what a Room continuation run should do next: a short directive tag, neutral instruction text, and structured context. Mirrors `ProposalApplierRegistry`'s ownership split — each domain registers its own handler alongside its applier (e.g. `registerProjectDefinitionContinuation` next to `registerProjectDefinitionProposalAppliers`); Rooms (`rooms/service.ts`) consumes the registry and holds no domain-specific continuation logic (plan: `.agent/plans/room-advancement-reliability-plan.md`, Phase 2). A rejected Proposal always gets the same generic revise instruction regardless of type; an accepted Proposal with no registered handler gets a generic "confirm and continue" fallback. A directive is a hint tag, not a forced tool call. A second trigger source (Phase 3) resolves a domain-completion event instead of a Proposal (`registerEvent`/`resolveEvent`) — a run group or research operation finishing, not a human decision — dispatched through `RoomService.continueAfterDomainEventInTransaction` and deduped by `(event kind, event key)` instead of a Proposal id. Unlike the Proposal side, an unregistered event kind throws: firing an event nobody registered a handler for is a wiring bug, not a legitimate case needing a fallback.

## Key Models

```
Proposal:
  id, space_id, project_folder_id
  proposal_type  — varchar(64), no CHECK; valid values are the types registered in ProposalApplierRegistry
  title, summary, rationale, payload_json
  risk_level (low|medium|high|critical)
  status (pending|staged|accepted|rejected|superseded|rolled_back) — no CHECK; "expired" is derived on read (pending and expires_at passed)
  preview  — if true, cannot be accepted
  created_by_agent_id, created_by_run_id, created_by_user_id
  required_approver_role, created_at, reviewed_at, reviewed_by

  payload_json carries:
    proposed_content, memory_type, target_scope, target_namespace, target_visibility
    provenance_entries  — required for memory_create/update; links to source ActivityRecord, Run, etc.
    source_evidence, sensitivity_level
    owner_user_id, subject_user_id, content_access_grants

ProposalApproval:
  id, proposal_id, approval_type ('egress_granting_user'|'action_grant')
  approver_user_id, grant_id, action_grant_id, target_space_id
  status (approved|revoked)
  metadata_json, created_at, revoked_at

CodePatchSnapshot:
  id, proposal_id, space_id, project_folder_id
  files_json  — array of {path, existed, content} captured before apply
  status (available|rolled_back|pruned)
  created_at, expires_at
  rolled_back_by_user_id, rolled_back_at
```

## Main Flow

1. Product code creates a `Proposal` (pending, not active memory)
2. User reviews and approves/rejects via `/api/v1/proposals/{id}/accept` or `/reject`.
   Both decisions are judged by the same role (`effectiveApproverRole`):
   `required_approver_role: "owner"` on a Project-scoped proposal means the
   Project's owner, for declining as much as for accepting. A malformed JSON
   body answers 422. The list is ordered by urgency, deadlines and
   `created_at`, with `id` as the unique last key so OFFSET pages over a
   packet's same-millisecond children neither repeat nor skip a row.
3. `PgProposalApplyService.accept(...)`:
   - Rejects preview proposals
   - Rejects already-accepted or rejected proposals
   - The memory applier enforces the `memory/sourceMonitoring.ts` source-trust gate (its accept context is fixed to `explicit_user_accept`)
   - Writes `ProvenanceLink` rows for accepted memory/policy changes
   - Dispatches through `ProposalApplierRegistry` to the target module's registered applier
4. `proposal.status = "accepted"`, `reviewed_at`/`reviewed_by` set, commit — durable write completes. No separate approval-event row is created for normal accept/reject. `ProposalApproval` rows are distinct egress approval metadata (written via `/proposals/{id}/approvals/egress-granting-user`). The registered `egress_review` applier requires every owner named by the target's current context taint to have an active approval before it publishes the target.
5. For `code_patch` proposals, a `CodePatchSnapshot` (pre-apply file content) is persisted inside the apply transaction. The user can later call `POST /api/v1/proposals/{id}/rollback` to restore files to their pre-apply state while the snapshot is within its retention window and status is `available`. Rollback has the reach every proposal decision has (`authorizeProposalDecision`: same Space, the state the decision acts on, readable, and inside a readable Room for a Run's proposal) plus the same `proposal.apply` role gate and `project_folder.write_patch` check as accept; a caller who can only read the accepted proposal cannot write the snapshot back. It refuses (409) when an applied file no longer hashes to what the patch wrote (`applied_files`), sets the proposal's status to `rolled_back`, and its activity — like the apply activity — takes the proposal's own visibility.

## Server Apply Boundary

The public proposal review/apply surface is owned by the server:

- The server owns external `/api/v1/proposals` list/get routes and the product
  read model/visibility rule.
- The server owns the external accept/reject/egress-approval HTTP routes and the
  proposal-apply transaction boundary for registered appliers.
- The server runs the `proposal.apply` policy gate before dispatching through its
  `ProposalApplierRegistry`. The gate enforces a proposal row's
  `required_approver_role` before applying the normal risk/role matrix.
- `createDefaultProposalApplierRegistry` (`proposals/applierRegistry.ts`)
  assembles the registry from each domain's `register*ProposalAppliers`. The
  currently registered appliers are: `memory_create`, `memory_update`,
  `memory_archive`, `policy_change`, `knowledge_create`, `knowledge_update`,
  `knowledge_archive`, `follow_up_task`, `claim_create`, `claim_update`,
  `claim_archive`, `object_relation_create`, `object_relation_delete`,
  `object_profile_create`, `object_profile_update`, `object_profile_deprecate`,
  `object_profile_archive`, `claim_candidate_packet`,
  `relation_discovery_packet`, `imported_history_memory_packet`,
  `memory_maintenance_packet`, `retrieval_maintenance_packet`,
  `retrieval_diagnostics_packet`, `code_patch`,
  `skill_import_approve`, `capability_install`, `capability_update`,
  `capability_enable`, `capability_disable`, and
  `runtime_skill_binding_update`, plus `custom_source_policy_delta`,
  `custom_source_credentialed_source`, `custom_source_repair_activation`,
  `source_recipe_activation`, `source_channel_activation`,
  `source_backfill_start`, `project_source_bind`,
  `evolvable_asset_version_promote`, `workflow_save`, `plan_review`,
  `plan_checkpoint`, `workflow_execution_checkpoint`,
  `evolution_bundle_rollback`, `research_query_strategy_activation`,
  `research_history_extend`, `project_brief_publish`, and `egress_review`.
  Unregistered proposal types fail closed until
  their owning domain registers an applier.
- `memory_maintenance_packet`, `retrieval_maintenance_packet`, and
  `retrieval_diagnostics_packet` are owner-private, creator-owned review
  packets; the current appliers reject another user, including a space admin,
  accepting someone else's private packet.
- Non-registered target-module appliers remain explicit fail-closed work; the
  server public route does not fall back to any external proposal port.
- Proposal creation entrypoints remain in their product modules
  (`memory`, `knowledge`, `agents`, `runs`, etc.).

This is intentional: the user-facing proposal review API keeps non-registered
proposal mutations fail-closed instead of silently no-oping.

## `accept_context` Values

`AcceptContext` (`memory/sourceMonitoring.ts`) is used only on the memory apply
path; `memoryApplyRepository.ts` fixes it to `explicit_user_accept`.

| Value | Caller |
|-------|--------|
| `explicit_user_accept` | The memory applier, reached from the proposal-accept HTTP paths |
| `internal_seed` | No current caller |
| `direct_apply` | No current caller; must not be used on public acceptance paths |

## Source Trust Gate

- `agent_inferred`-only provenance cannot become active semantic memory or policy.
- `untrusted_external` semantic/policy proposals may proceed only under `explicit_user_accept` with `source_monitoring_result` recorded on the proposal payload.

## Invariants
- No irreversible change executes without an approved Proposal
- Preview proposals cannot be accepted
- Accepted proposals cannot be re-applied
- Rejected proposals do not create memory or relations
- `ProposalApplyService` is the only normal durable write path
- Target modules own proposal business mutations; `proposals` owns the registry and approval/apply orchestration
- `provenance_links` are required for accepted memory and policy changes
- Agents generate Proposals; humans approve explicitly or in advance through
  a scoped, expiring, use-limited ActionApprovalGrant. Both modes retain the
  Proposal and approval audit record.
- A proposal exists for one of the seven gate classes in
  [ADR 0017](../decisions/0017-authorization-by-cost-not-authorship.md) §1 and
  names which (`gate_class` on the action registration). Opening an Inquiry
  Thread and recording its conclusion are no longer among them: they are
  origin-gated, bounded direct writes, reviewed afterwards from the Project's
  updates.
- `code_patch` rollback requires a non-expired `available` snapshot and every applied file unchanged since apply; once used, status becomes `rolled_back` and cannot be reused. It also requires the same apply / `write_patch` authority as accept.
- Snapshot retention (days + max count) is configurable per-Project-Folder and per-space; builtin defaults are 7 days / 20 snapshots

## Related Files
- `server/migrations/`
- `server/src/modules/proposals/`
- `server/src/modules/proposals/applyService.ts`
- `server/src/modules/*/` proposal appliers
- `server/src/modules/memory/sourceMonitoring.ts`
- `server/src/modules/artifacts/`
- `server/src/modules/runs/materializationService.ts`

## Related Decisions
- [0003-memory-proposal-flow.md](../decisions/0003-memory-proposal-flow.md)
