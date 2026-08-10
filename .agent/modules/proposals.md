# Module: Proposals

## Purpose
Approval workflow. Durable memory and code changes must go through a Proposal before taking effect. `ProposalApplyService` is the only normal durable write path.

## Owns
- `Proposal` model (generalized, any type)
- `ProposalApproval` — egress_granting_user approval gate (MVP: this approval type only)
- `Artifact` (persistent output of agent runs)
- `ProposalApplyService` — validates source trust, writes provenance links, and dispatches through `ProposalApplierRegistry` to module-owned appliers
- `SourceMonitoringService` — gates semantic/policy acceptance by source trust

## Key Models

```
Proposal:
  id, space_id, project_folder_id
  proposal_type (memory_create|memory_update|memory_archive|memory_maintenance_packet|object_profile_create|object_profile_update|object_profile_deprecate|object_profile_archive|policy_change|code_patch|egress_review|follow_up_task|custom_source_policy_delta|custom_source_credentialed_source|custom_source_repair_activation|source_recipe_activation)
  title, summary, rationale, payload_json
  risk_level (low|medium|high|critical)
  status (pending|accepted|rejected|superseded|expired)
  preview  — if true, cannot be accepted
  created_by_agent_id, created_by_run_id, created_by_user_id
  required_approver_role, created_at, decided_at

  payload_json carries:
    proposed_content, memory_type, target_scope, target_namespace, target_visibility
    provenance_entries  — required for memory_create/update; links to source ActivityRecord, Run, etc.
    source_evidence, sensitivity_level
    owner_user_id, subject_user_id, content_access_grants

ProposalApproval:
  id, proposal_id, approval_type ('egress_granting_user')
  approver_user_id, grant_id, target_space_id
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
2. User reviews and approves/rejects via `/api/v1/proposals/{id}/accept` or `/reject`
3. `ProposalApplyService.apply(proposal, accept_context="explicit_user_accept")`:
   - Rejects preview proposals
   - Rejects already-accepted or rejected proposals
   - Enforces `SourceMonitoringService` for semantic/policy types
   - Writes `ProvenanceLink` rows for accepted memory/policy changes
   - Dispatches through `ProposalApplierRegistry` to the target module's registered applier
4. `proposal.status = "accepted"`, `decided_at` set, commit — durable write completes. No separate approval-event row is created for normal accept/reject. `ProposalApproval` rows are distinct egress approval metadata (written via `/proposals/{id}/approvals/egress-granting-user`). The registered `egress_review` applier requires every owner named by the target's current context taint to have an active approval before it publishes the target.
5. For `code_patch` proposals, a `CodePatchSnapshot` (pre-apply file content) is persisted inside the apply transaction. The user can later call `POST /api/v1/proposals/{id}/rollback` to restore files to their pre-apply state while the snapshot is within its retention window and status is `available`.

## Server Apply Boundary

The public proposal review/apply surface is owned by the server:

- The server owns external `/api/v1/proposals` list/get routes and the product
  read model/visibility rule.
- The server owns the external accept/reject/egress-approval HTTP routes and the
  proposal-apply transaction boundary for registered appliers.
- The server runs the `proposal.apply` policy gate before dispatching through its
  `ProposalApplierRegistry`. The gate enforces a proposal row's
  `required_approver_role` before applying the normal risk/role matrix.
- The currently registered appliers are: `memory_create`, `memory_update`,
  `memory_archive`, `knowledge_create`, `knowledge_update`, `knowledge_archive`,
  `follow_up_task`, `claim_create`, `claim_update`, `claim_archive`,
  `object_relation_create`, `object_relation_delete`,
  `object_profile_create`, `object_profile_update`, `object_profile_deprecate`,
  `object_profile_archive`,
  `memory_maintenance_packet`, `retrieval_maintenance_packet`,
  `retrieval_diagnostics_packet`, `code_patch`,
  `skill_import_approve`, `capability_install`, `capability_update`,
  `capability_enable`, `capability_disable`, and
  `runtime_skill_binding_update`, plus `custom_source_policy_delta`,
  `custom_source_credentialed_source`, `custom_source_repair_activation`, and
  `source_recipe_activation`, and `egress_review`.
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

| Value | Caller |
|-------|--------|
| `explicit_user_accept` | User/admin proposal-accept HTTP paths |
| `internal_seed` | DB seed, migration, or tests that intentionally bypass monitoring |
| `direct_apply` | In-process tests/tools; must not be used on public acceptance paths |

## Source Trust Gate

- `agent_inferred`-only provenance cannot become active semantic memory or policy.
- `untrusted_external` semantic/policy proposals may proceed only under `explicit_user_accept` with `source_monitoring_result` recorded on the proposal payload.
- `bypass_source_monitoring` is for tests/seeds only — not bound to HTTP request bodies or runtime adapters.

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
- `code_patch` rollback requires a non-expired `available` snapshot; once used, status becomes `rolled_back` and cannot be reused
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
