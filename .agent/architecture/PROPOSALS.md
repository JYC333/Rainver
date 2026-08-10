# Proposals

Date: 2026-06-19

Proposals are the product review and application boundary for durable mutations.

## Product API

- `/api/v1/proposals` is the only product API for proposal review and application.
- In the current server stack, external proposal review routes are
  owned by the server. List/get are served by the server DB read model.
  Accept/reject/egress approval run in the server proposal apply service and share
  the server transaction boundary with the applier registry. Proposal creation
  entrypoints remain in their source product modules.
- `GET /api/v1/proposals` defaults to pending proposals.
- `status=all` is explicit and returns proposals across statuses.
- Product-recognized proposal types are `memory_create`, `memory_update`,
  `memory_archive`, `policy_change`, `code_patch`, `egress_review`,
  `follow_up_task`, `agent_config_update`, `knowledge_create`,
  `knowledge_update`, `knowledge_archive`, `claim_create`, `claim_update`,
  `claim_archive`, `object_relation_create`, `object_relation_delete`,
  `claim_candidate_packet`, `memory_maintenance_packet`,
  `retrieval_maintenance_packet`, `retrieval_diagnostics_packet`,
  `custom_source_policy_delta`, `custom_source_credentialed_source`, and
  `custom_source_repair_activation`.
- Registered server apply types include `memory_create`, `memory_update`,
  `memory_archive`, `policy_change`, `code_patch`, Knowledge proposal types,
  Claim Candidate Packet, retrieval review packet types, task proposal types,
  Project Folder proposal types, and capability proposal types contributed through
  the server `ProposalApplierRegistry`, plus the Custom Source proposal types
  registered by the Sources module. Unregistered proposal types fail closed on accept
  until their owning domain registers a server applier. `egress_review` approval
  rows are supported, but `egress_review` does not currently have a registered applier.
- Accept returns the general `ProposalAcceptOut` response shape.
- Agent-created proposals remain pending by default. A grantable System Action
  may be applied immediately only when a matching human-created
  `ActionApprovalGrant` is atomically consumed; the proposal and an
  `action_grant` approval row are still durable. Never-grantable actions always
  require fresh explicit review.
- `POST /api/v1/proposals/:proposalId/rollback` restores Project Folder files to their
  pre-apply state from a `code_patch_snapshots` record captured at accept time.
  Rollback is only available while the snapshot is within its retention window and
  has not already been used. The rollback route is space-scoped (requires the same
  `spaceId` as the proposal) and writes a `proposal.code_patch.rolled_back`
  activity record.

## Application Rules

- The server apply service must run the `proposal.apply` policy gate before
  dispatching any registered applier.
- `proposal.apply` honors `proposals.required_approver_role` before the generic
  risk/role matrix. For example, an owner-required medium-risk proposal cannot
  be accepted by an admin or reviewer even though medium risk would otherwise
  permit reviewer approval.
- `memory_create`, `memory_update`, and `memory_archive` mutate durable memory
  only when accepted.
- Knowledge proposal records are reviewable through the proposal API, and
  Knowledge apply is registered in the server applier registry for
  `knowledge_create`, `knowledge_update`, `knowledge_archive`,
  `claim_create`, `claim_update`, `claim_archive`,
  `object_relation_create`, and `object_relation_delete`.
- Knowledge read and proposal creation endpoints are viewer-aware. Private
  Knowledge requires its owner and selected-user Knowledge requires an active grant; unauthorized same-space
  users receive 404 for item reads and cannot create update/archive/relation
  proposals involving hidden endpoints.
- Knowledge proposal apply must repeat domain-specific authorization after
  `proposal.apply` allows acceptance when that applier is registered. Malformed
  or internally seeded proposals must not mutate another user's private or
  selected-user Knowledge or relations that include inaccessible endpoints.
- Claim proposal apply enforces claim lifecycle rules: no `superseded` or
  `archived` claim creation, terminal archived claims, restricted
  `active/disputed/superseded/rejected` transitions, disputed-resolution
  compatibility, and successor evidence for superseded claims.
- Memory maintenance packet apply records creator-owned review of owner-private
  Memory maintenance work. A space admin cannot accept another user's private
  packet through the current applier. It acknowledges review and may create
  child pending `memory_archive` proposals for supported duplicate findings and
  child pending `memory_update` proposals for supported stale, thin, lifecycle,
  archived-state, project-scope, source-policy, and contradiction findings. It
  does not write canonical Memory directly; child proposals still require their
  own normal review/apply step.
- Retrieval maintenance and diagnostics packet apply records creator-owned
  review of owner-private retrieval work. A space admin cannot accept another
  user's private packet through the current appliers. Retrieval maintenance
  packets may create child pending `object_relation_create` proposals for
  supported relation suggestions. Diagnostics packets only acknowledge review and do not
  write canonical Knowledge or Memory.
- Claim Candidate Packet apply records creator-owned review of owner-private
  candidate claim work, or shared `space_ops` review when Context Ops review mode
  allows it. Accepting a `claim_candidate_packet` creates child pending
  `claim_create` or `object_relation_create`
  proposals from valid candidates only; it does not directly write canonical
  Claims, Object Relations, Knowledge, or Memory. Invalid child
  candidate payloads are skipped and recorded on the accepted packet payload as
  `skipped_child_proposal_count` plus bounded skip records, instead of being
  silently dropped.
- Retrieval Brief gap analysis is not a separate proposal route. Brief
  `uncited_claims`, contradictions, missing topics, stale refs, and thin refs
  remain artifact metadata until a user/operator explicitly creates a
  `claim_candidate_packet`, retrieval maintenance packet, diagnostics packet, or
  Memory maintenance packet from selected artifacts/reports.
- `policy_change`, `follow_up_task`, `agent_config_update`, and other
  non-memory target mutations are not currently registered server appliers. They
  fail closed until their owning domain registers a server applier.
- Custom Source proposal apply validates the handler version/proposal binding,
  rejects stale active-pointer or envelope changes, and then activates the
  named handler version while superseding the previous active version.
- `code_patch` proposals are accepted via the server applier; pre-apply file
  snapshots are captured automatically and pruned by retention policy (default
  7 days / 20 max per Project Folder, configurable per-Project-Folder and per-space).
- Evolution bundles are a review grouping with exclusive ownership of their
  pending members. Their member decisions run through `ProposalApplyService`
  in the same database transaction as the member state transition; ordinary
  proposal accept/reject routes cannot bypass an active bundle. D3 rollback is
  represented by an `evolution_bundle_rollback` proposal, so it receives the
  normal `proposal.apply` policy/audit gate, and its successful reverse-order
  restoration writes an activity record. Bundle rejection emits the same
  `proposal_rejected` signal as ordinary rejection, but only from a post-commit
  callback. Transactional apply results retain external compensation handles
  (for example, code-patch file rollback) until the owning transaction has
  committed. Rollback preflight exposes blockers and refuses to create a
  rollback proposal for unsupported members; promotion and rollback serialize
  on a sorted asset-level transaction advisory lock. It is fail-closed when a
  member type has no supported snapshot adapter. Snapshot capture acquires the
  asset lock before reading the asset version/reference set, not only when the
  promotion applier starts. The PostgreSQL workflow suite includes barrier-
  controlled same-asset Bundle/Bundle and Bundle/ordinary-promotion cases; it
  must run against the shared Testcontainers database when that runtime is
  available.
- Public post-create execution config changes for Agents must use
  `POST /api/v1/agents/{agent_id}/config-proposals`; direct
  `POST /agents/{agent_id}/versions` does not advance the current version.
- Rejected, accepted, expired, or superseded proposals cannot be applied again.
- Cross-space or unauthorized access must not reveal proposal details.

## Audit Rules

- Proposal creation, acceptance, and rejection must be durable.
- User-created memory proposals use the `proposal.create` policy gate.
- Agent execution config proposals use the `agent.config_update` policy gate
  at proposal creation and `proposal.apply` at acceptance.
- Agent-generated Knowledge proposals use the same review boundary:
  Activity, Run, or Artifact source -> `knowledge_*` proposal -> human
  acceptance -> active Knowledge record. They must not auto-activate and must
  not auto-enter Memory or an accepted Runtime Context Delivery.
- Knowledge proposal apply is implemented through the server
  `ProposalApplierRegistry`. Source monitoring has an explicit code boundary
  for Knowledge, but the full evaluator for external or untrusted
  Activity/Artifact-derived Knowledge remains future work.
- Accepted proposals keep enough result detail for callers to identify the applied product effect.
- Automatic grant acceptance records `approval_source=action_grant:<id>` and
  increments the bounded grant use count in the same transaction as apply.
- Proposal application must be idempotence-safe at the API boundary: repeated accept attempts must not repeat the mutation.
