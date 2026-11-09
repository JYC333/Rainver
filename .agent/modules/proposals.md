# Module: Proposals

## Purpose
Approval workflow. Durable memory and code changes must go through a Proposal before taking effect. `ProposalApplyService` is the only normal durable write path.

## Owns
- `Proposal` model (generalized, any type)
- `ProposalApproval` — `egress_granting_user` approval gate and `action_grant` pre-authorization rows
- `Artifact` (persistent output of agent runs)
- `PgProposalApplyService` (`accept` / `acceptInTransaction` / `reject` / `approveEgressGrantingUser` / `rollback`) — runs the apply gate and dispatches through `ProposalApplierRegistry` to module-owned appliers
- Source-trust gating of memory acceptance lives in the memory applier path (`memory/sourceMonitoring.ts` gate functions), not in a proposals service
- `ConversationContinuationRegistry` (`proposals/continuationRegistry.ts`) — maps a resolved (accepted/rejected) Proposal to what a Room continuation run should do next: a short directive tag, neutral instruction text, and structured context. Mirrors `ProposalApplierRegistry`'s ownership split — each domain registers its own handler alongside its applier (e.g. `registerProjectDefinitionContinuation` next to `registerProjectDefinitionProposalAppliers`); Rooms (`rooms/service.ts`) consumes the registry and holds no domain-specific continuation logic. A rejected Proposal always gets the same generic revise instruction regardless of type; an accepted Proposal with no registered handler gets a generic "confirm and continue" fallback. A directive is a hint tag, not a forced tool call. A second trigger source resolves a domain-completion event instead of a Proposal (`registerEvent`/`resolveEvent`) — a run group or research operation finishing, not a human decision — dispatched through `RoomService.continueAfterDomainEventInTransaction` and deduped by `(event kind, event key)` instead of a Proposal id. Unlike the Proposal side, an unregistered event kind throws: firing an event nobody registered a handler for is a wiring bug, not a legitimate case needing a fallback.

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
   - Writes `ProvenanceLink` rows for accepted memory changes
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
  `memory_archive`, `knowledge_create`, `knowledge_update`,
  `knowledge_archive`, `follow_up_task`, `claim_create`, `claim_update`,
  `claim_archive`, `object_relation_create`, `object_relation_delete`,
  `object_profile_create`, `object_profile_update`, `object_profile_deprecate`,
  `object_profile_archive`, `claim_candidate_packet`,
  `relation_discovery_packet`, `imported_history_memory_packet`,
  `memory_maintenance_packet`, `retrieval_maintenance_packet`,
  `retrieval_diagnostics_packet`, `code_patch`,
  `skill_import_approve`, `runtime_skill_binding_update`, plus `custom_source_policy_delta`,
  `custom_source_credentialed_source`, `custom_source_repair_activation`,
  `source_recipe_activation`, `source_channel_activation`,
  `source_backfill_start`, `project_source_bind`,
  `evolvable_asset_version_promote`, `workflow_save`, `plan_review`,
  `plan_checkpoint`, `workflow_execution_checkpoint`,
  `evolution_bundle_rollback`, `research_query_strategy_activation`,
  `research_history_extend`, `project_brief_publish`,
  `project_information_monitoring_details`,
  `project_information_monitoring_activation`, and `egress_review`.
  Unregistered proposal types fail closed until
  their owning domain registers an applier.
  Migration `0004_remove_capability_layer` supersedes pending legacy capability
  install/update/enable/disable proposals with a reason; their history remains
  readable, and accepted/rejected rows are unchanged.
- `memory_maintenance_packet`, `retrieval_maintenance_packet`, and
  `retrieval_diagnostics_packet` are owner-private, creator-owned review
  packets; the current appliers reject another user, including a space admin,
  accepting someone else's private packet.
- Non-registered target-module appliers remain explicit fail-closed work; the
  server public route does not fall back to any external proposal port.
- Proposal creation entrypoints remain in their product modules
  (`memory`, `knowledge`, `agents`, `runs`, etc.).
- The stored `title` is the text for API and non-web readers. A proposal type
  whose title is composed from facts records them in its payload and exposes
  them as `title_parts` (`proposals/titleParts.ts`), so the web words the title
  per locale; `evolvable_asset_version_promote` records `asset_key` and
  `candidate_version` for this. Proposals without those facts keep their
  stored title everywhere.

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
- `provenance_links` are required for accepted memory changes
- Agents generate Proposals; humans approve explicitly or in advance through
  a scoped, expiring, use-limited ActionApprovalGrant. Both modes retain the
  Proposal and approval audit record.
- A proposal exists for one of the seven gate classes in
  [ADR 0017](../decisions/0017-authorization-by-cost-not-authorship.md) §1 and
  names which (`gate_class` on the action registration). Opening an Inquiry
  Thread and recording its conclusion are not among them: they are
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

## P5 internal transition port (partial writer migration)

Canonical DB decisions now enter operation-owned Proposal transition admission
before row/domain locks. The port in
`systemActions/operations/proposalTransitions.ts` discovers the affected set,
acquires every linked request key nonblockingly in sorted full-scope order,
then Proposal closure gates/rows in stable id order, request rows, and finally
the owning domain locks. Dependency/link drift conflicts without late key
acquisition or automatic retry. Source activation rejection supersedes pending
recursive dependents and their linked requests in the same transaction.

Canonical dependency insertion joins the parent closure gate and rechecks
same-Space parent state. Accepted parents retain valid dependency authority after
their old review deadline; rejected/superseded/missing parents cannot gain new
pending dependents after rejection. Standalone insertion owns a short transaction;
existing transaction clients and branded ports join the caller's transaction.
Pending operation linking separately locks and rechecks Proposal status/expiry
and exact frozen payload before persisting the request.

Direct Project definition and monitoring scope/details replacement writers join
the same transition port before their Project/advisory domain locks. Proposal,
replacement draft/version and request terminal outcome roll back together.
These are internal writer migrations, not new public operations or approvals.

Linked canonical acceptance still requires the existing mapped integration and
full policy-audit recovery owner. It validates/records the actual applier result;
accepted-without-atomic-result remains inconsistent. Bare acceptance, advance-
grant application and external code-patch rollback cannot substitute for the
frozen requester mapping. Unlinked approvals retain their canonical role,
owner, risk, Source consent, provenance and B10 applier rules.

The next P5-4 subset extends this port to Memory/imported-history pending
payload revision, Plan review supersession, complete Skill review sets and
Run recovery/standalone terminal publication. Linked payload revision preserves
the old Proposal and frozen payload, supersedes that Proposal/request together,
and inserts a fresh pending Proposal with the same audience, provenance, role,
deadlines and pending-domain identity. It copies active audience grants, never
approvals or the old Run tool-call identity. Both callers return the new id;
the Memory detail page follows it. Unlinked edits retain their id. Only the
canonical applier may publish active Memory (B10).

Skill review admission resolves pending package siblings and their linked
requests before the package lock; all siblings supersede atomically. Review
creation shares the package closure gate and rechecks that review is still open.
Concurrent decisions conflict without SKIP LOCKED or automatic retry. A root
without a linked request still uses transactional policy audit/recovery when
its sibling closure contains linked requests.

Run recovery admits keys per independent candidate transaction before
Proposal/request/Run locks, then retains the existing Run/Attempt/Proposal/lock
CTE. Request attachment shares the Run fence; late staged output derives its
pending/rejected state from the current terminal Run. Materialization keeps
model/filesystem IO outside the short audit/Proposal/audience DB transaction.
Independent terminal calls join the same port. Pool-owned Plan/Workflow reconcile,
Project archive, backing Job cancellation/exhaustion, stale autonomous child
cancellation, queued Host merge resolution cancellation and Reading provider
finalization now prepare their exact complete Run set before any domain lock.
Nested calls reuse the parent's expiring purpose-bound port; set growth conflicts
without a late key. Canonical user accept now prepares checkpoint/Research-history
Proposal/cascade and graph Run request sets together immediately after BEGIN,
following a nonlocking visible-decision preflight. Nested transition writers
reuse the actual transaction's admitted closure. This is not production mapping
qualification; unprepared outer callers still cannot take keys late. Evolution now admits all selected/cascade/checkpoint requests before its Bundle
row lock. Pure DB selections commit once; mixed code-patch selections persist an
intent plus required Job, execute IO outside transactions and feed private effect
receipts back to the same canonical appliers for one final DB commit. See
[the Evolution owner guide](../architecture/EVOLUTION_SIGNAL_SYSTEM.md#evolution-bundles)
for crash recovery, compensation and the non-atomic external visibility boundary. No alternate
DB-only decision dispatcher, direct Memory writer, production mapping or public
proposal.decide authority is introduced.

Project definition/monitoring preflight current writer authority without locks
before admission and retain the locked authoritative check after it. A newly
observed pending replacement outside the admitted set returns nonretryable 409
operation_conflict; callers reread and explicitly initiate a new action. The
writer never acquires late keys or automatically retries a changed decision.
Project Source binding dependencies must be full-readable without oversight,
same-Space/same-Project source_channel_activation Proposals for that channel.
Creation checks full/no-oversight read; apply uses canonical review reach as
clarified below. A dependency never grants Source execution,
owner consent or egress permission.

Review correction: binding **submission** still requires full-readable activation
without oversight; binding **application** uses the existing canonical Proposal
review view (including its established oversight/Room reach), not an invented
full-read prerequisite. Same-Space/Project/type/channel checks apply in both
cases. A parent hidden from that canonical view remains hidden; review adds no
Source execution, owner-consent or egress grant.

A revised frozen draft's old caller key remains bound to its original Proposal
and receipt, even after supersession. It never redirects to the new review id or
copies approvals. The caller follows the returned revision id, rereads current
pending Proposals, and uses a new action/key for a new decision. This guidance is
also supplied by the Agent work skill. Browser parent tests now exercise acceptance
of the returned new id as well as navigation to it.

Checkpoint/history and Bundle owners retain their private prepared scope across
nested core transaction ports through the existing internal host bridge. Empty
known checkpoint sets still prepare a scope so fresh canonical Runs/Proposals
can register on that exact lifetime. Unknown existing Runs and fresh Runs linked
in that transaction refuse terminal publication rather than taking late keys.
An unrelated still-active Research Run may retain staged output/pending request;
terminal staged output remains inconsistent. Immutable terminal graph histories
without staged output are excluded from related discovery; explicit checkpoint
roots and actual dependent cascades are retained. History-extension preflight
uses the same Project writer gate as its canonical applier (including the payload
Project fallback), not a new reviewer permission. Mandatory audits for these
prepared owners join the real transaction and recover only after rollback/release.

Bundle transaction Pools must expose `options.connectionString` for canonical
audit recovery; missing configuration fails before writes. No production approval
mapping or public proposal.decide expansion is enabled by writer closure alone.

P5-4 standalone file decisions now enter the same durable effect protocol as
Evolution: `projectFolders/codePatchDecision` owns a required Job and frozen intent;
`codePatchEffects` owns outside-transaction IO; `acceptInTransaction` remains the
canonical final applier. No synchronous IO fallback exists in that applier or in
explicit rollback. Pending is not accepted; only the real final result/receipt
can terminalize a linked request. Original-key historical results are immutable,
including after explicit rollback. A changed frozen Proposal must be reread and
decided as its own revision, never substituted into the old intent.

The remaining raw creation sites in Plan checkpoint scheduling, Workflow checkpoint
scheduling and Knowledge Candidate promotion now use `insertProposalRow` on their
existing transaction port. Field ownership, audience, approval role, scheduling
and Candidate provenance are retained; fresh Proposal registration joins the exact
prepared owner lifetime. SQL status/payload mutation sites remain the canonical
apply/cascade, payloadRevision, definition/monitoring replacement, Skill set,
Plan review, Run terminal/publication and P1 hook owners. No independent direct
Memory writer or new public decision authority is introduced.
