# Policy and Privacy Boundaries

This document describes the canonical policy enforcement stack and privacy
invariants for rainver. All information here describes the current
enforced state.

---

## Policy Architecture

The policy stack is:

```
checkHardInvariants
  → engineCheck
  → computeDecision (composes the above; DB-free)
  → enforce / enforceProposalApply (enforcement entry points)
  → PolicyDecisionRecord (durable audit evidence)
  → optional RunEvent metadata
```

### 1. Hard invariants (`checkHardInvariants`)

Non-overridable security/privacy invariants. These cannot be weakened by
Policy rows, runtime configuration, or caller-supplied context. They run
before the engine rules.

Location: `server/src/modules/policy/decisionCore.ts`

### 2. Engine (`engineCheck`)

Stateless decision engine over canonical actions and built-in rules.
Returns `allow`, `require_approval`, or `deny`.

**Registry default behavior**: When no built-in rule matches, the engine
returns the action definition's `default_decision` — not a permissive ALLOW.
Unknown actions always return DENY with `audit_code="unknown_policy_action"`.

Location: `server/src/modules/policy/decisionCore.ts`

### 3. Decision composition (`computeDecision`)

DB-free composition of the hard invariants and engine for one request, plus the
durable-audit helpers (`isDurableAuditRequired`, `resolveFailureMode`,
`buildAuditEnvelope`) and the proposal-apply check (`checkProposalApplyPolicy`).

Location: `server/src/modules/policy/gateway.ts`

### 4. Enforcement (`enforce` / `enforceProposalApply`)

Main service entry points for sensitive actions. They compute the decision,
persist the PolicyDecisionRecord when required, and return an `EnforceResult`
(`status: "allow" | "blocked" | "error"` with an `error_code`).

Location: `server/src/modules/policy/service.ts`

Business code enforcing wired sensitive actions must use `enforce()` or, for
proposal application, `enforceProposalApply()`. Do not call `computeDecision`,
`engineCheck`, or `checkHardInvariants` directly to authorize or perform a
sensitive action.

**Non-mutating simulation exception:** one location calls `computeDecision`
directly for preflight simulation — it is not an enforcement point and must not
persist `PolicyDecisionRecord`. Real runtime execution still goes through
`enforce()`.
- `AutomationService.runPreflight` (`server/src/modules/automations/service.ts`) —
  read-only policy preflight simulation for a manual or scheduled Automation
  fire, reached through `preflightAgentRun` / `preflightWorkflow`. It reads the
  Agent's enabled default `AgentRuntimeProfile` and simulates
  `runtime.use_credential` only when that Profile's `model_provider_id` is set.

All other business code performing enforcement must call `enforce()` or
`enforceProposalApply()`; direct `computeDecision`, `engineCheck`, or
`checkHardInvariants` usage outside that one location is a boundary violation.
No automated check enforces this today — it is a review rule.

#### PolicyCheckRequest field semantics

| Field | Role |
|-------|------|
| `context` | **Decision inputs** consumed by the hard invariants and engine rules. Keys are flattened into the guard context. Fields such as `agent_status`, `tool_name`, `trigger_origin`, `derived_from_personal_memory_grant`, `raw_private_memory_included`, `target_visibility`, and `target_space_id` must appear here. |
| `metadata_json` | **Audit-only metadata** written to `PolicyDecisionRecord`. It never grants permission or satisfies approval. Forbidden sentinel fields in this audit bag may still trigger defensive hard DENY, such as `personal_context_block` or approval-proof flags. Dangerous fields are stripped by `sanitizePolicyMetadata()`. |
| `payload` | Proposal or policy payload. Only the hard invariants read it (approval-proof flag check for `proposal.apply` / `policy.change`). Not a decision input for any other action. |

### 5. PolicyDecision fields

Every `PolicyDecision` returned by the enforcement entry points, the engine, or
the hard invariants carries three stable machine-readable codes:

| Field | Purpose | Example |
|-------|---------|---------|
| `reason_code` | Stable, machine-readable code for the decision outcome. Consumers can branch on it without parsing `message`. | `"space_boundary"`, `"approved_owner"`, `"hard_invariant_cross_space_memory"` |
| `policy_rule_id` | Identifies the specific rule or invariant that produced this decision. Useful for per-rule analytics. | `"proposal_apply_owner_allow"`, `"hard_invariant_cross_space_memory"` |
| `audit_code` | Stable durable search token persisted in `PolicyDecisionRecord`. Used for audit queries. | `"cross_space_access_denied"`, `"policy_action_not_implemented"` |

**`reason_code` is NOT persisted in `PolicyDecisionRecord`.**
Durable audit relies on `audit_code` (searchable in DB) and `policy_rule_id`
(also stored in `policy_rule_id` column). `reason_code` is an ephemeral
in-process field for runtime branching only.

### 6. PolicyDecisionRecord

Append-only durable evidence of sensitive policy decisions. Persisted for:
- Actions with `audit_required=True`
- Any DENY decision
- Any REQUIRE_APPROVAL decision
- Caller-forced records

Stores `audit_code` and `policy_rule_id` for durable audit queries.
Does **not** store `reason_code` — that is an ephemeral in-process field.

**Never stores**: raw memory content, `personal_context_block`, credentials,
API keys, prompts, patch bodies, stdout/stderr, full file content.
Metadata is sanitized via `sanitizePolicyMetadata()` before persistence.
Records required by enforcement are written exactly once through
`writePolicyAudit()` (`policy/auditWriter.ts`) on its own pool connection,
independent of the caller's transaction. A blocking decision returns
`status: "blocked"` (`error_code` `policy_denied` or `policy_requires_approval`)
and its record is written best-effort — the denial stands either way. A
fail-closed ALLOW whose durable write fails returns `status: "error"`
(`policy_audit_persist_failed`), so the sensitive action cannot proceed. No
business object is committed solely to commit policy audit evidence.

Database table: `policy_decision_records`

---

## Action Registry

Every sensitive action is registered in `packages/protocol/src/policy.ts` and
loaded by `server/src/modules/policy/actionRegistry.ts`. The
registry defines:
- `default_decision` — authoritative when no rule matches
- `default_risk_level`
- `audit_required`
- `approval_capability`
- `default_required_approver_role`
- `current_enforcement_point` — real module path for wired actions; `"not_implemented"` for reserved
- `lifecycle_status` — three states (see below)
- `record_failure_mode` — `PolicyRecordFailureModeEnum`: `best_effort` | `fail_closed` (see below)

### lifecycle_status

| Value | Meaning |
|-------|---------|
| `wired_direct` | Action has a direct `enforce()` call site in business code. |
| `wired_via_proposal` | Action is protected via `enforceProposalApply()` only. |
| `reserved` | Registered for vocabulary completeness; no enforcement point. Always fails closed with DENY regardless of `default_decision`. |

Unknown actions fail closed with DENY (`audit_code="unknown_policy_action"`).

### record_failure_mode (`PolicyRecordFailureModeEnum` in `packages/protocol/src/policy.ts`)

| Value | Behavior when PolicyDecisionRecord persistence fails |
|-------|-----------------------------------------------------|
| `best_effort` | Continue — action is not blocked. |
| `fail_closed` | `enforce()` returns `status: "error"` (`policy_audit_persist_failed`) — the sensitive action must not proceed. |

The per-action mode lives in `POLICY_ACTION_REGISTRY` (`packages/protocol/src/policy.ts`),
which is authoritative. `fail_closed` actions include `runtime.use_credential`,
`artifact.persist`, `proposal.apply`, `policy.change`,
`project_folder.write_patch`, `project_folder.apply_patch`, `run.spawn_child`,
`automation.create` / `update` / `fire`, `input_resource.read` / `search`,
`runtime_context_policy.change`, `work_context_setup.change`,
`authorization.request.create`, `capability.enable` / `disable` / `update`,
`skill.import` / `convert`, `runtime_skill.binding_update`, the retrieval
actions, and the Task / inquiry System Actions.

Dynamic escalation to `fail_closed` (regardless of per-action default):
- `trigger_origin` `"automation"` or `"autonomous"` + `audit_required=true` on the action — **regardless of ALLOW/DENY/REQUIRE_APPROVAL**.
- `risk_level=critical` + `audit_required=true` on the action — **regardless of ALLOW/DENY/REQUIRE_APPROVAL**.
- `trigger_origin` `"automation"` or `"autonomous"` + non-ALLOW on non-audit-required actions.
- `risk_level=critical` + non-ALLOW on non-audit-required actions.

**Business-boundary error conversion** — durable audit failures must block
sensitive operations. Callers treat any `EnforceResult.status` other than
`allow` as a refusal: `RunOrchestrationService` fails Run preparation before
credential resolution, context rendering, or adapter invocation; proposal apply
leaves the proposal pending with no side effects; Project Folder code patch
apply writes no files; `RunMaterializationService` writes no file or Artifact
row.

### WIRED_VIA_PROPOSAL clarification

`memory.create`, `memory.update`, `memory.archive`, and `policy.change` are **WIRED_VIA_PROPOSAL**. This means:

- There is **no direct** sensitive-action enforcement call for `memory.create`, `memory.update`, `memory.archive`, or `policy.change`.
- Protection is achieved through `enforceProposalApply()` in proposal apply acceptance.
- `proposal.apply` is the fail_closed audit and approval gate for all of these actions.
- Automation preflight calls `computeDecision` directly for non-mutating simulation — it does not write `PolicyDecisionRecord` rows. Real enforcement is exclusively in `RunOrchestrationService`.
- Automation supports manual and schedule-triggered fire. Its create/update/fire service paths use `enforce()` for automation management; create/fire then run runtime preflight and policy preflight simulation. Schedule ticks invoke the same `AutomationService.fire()` path; no external event trigger is implemented. Scheduled automations can carry same-space `AutomationCredentialGrant` pre-authorization.

---

## Hard Invariants

These invariants are enforced unconditionally and cannot be overridden:

1. **Space isolation** — cross-space memory reads require an explicit
   PersonalMemoryGrant. No Policy row can open cross-space access.

2. **Targeted publication does not grant source access** — target Spaces receive
   immutable snapshots and imports, never a live source read.

3. **personal_context_block is ephemeral** — it must never be persisted.
   Any persistence action with `personal_context_block` in metadata or
   context is denied.

4. **raw_private_memory_included=true blocks egress** — any egress-sensitive
   action with this flag is denied.

5. **Public target visibility blocks grant-derived output** — artifacts and
   proposals derived from personal memory grants cannot have public visibility.

6. **Payload metadata is not approval proof** — flags like `approved_by_user`,
   `auto_approved`, `pre_approved` in payload/metadata are ignored as approval
   evidence and cause denial.

7. **Unknown target space in egress-sensitive path fails closed** — DENY.

---

## Product Roles

Canonical roles (ascending authority):

| Role     | Approval authority | Other authority |
|----------|--------------------|-----------------|
| guest    | None | Read invited content only |
| member   | None | Create activity, artifacts, proposals; run low-risk allowed actions |
| reviewer | Low and medium risk | Approve memory/wiki/task proposals with effective risk ≤ medium |
| admin    | Low, medium, and high risk | Approve policy/capability/credential/workspace proposals with effective risk ≤ high |
| owner    | All risk levels including critical | Full authority inside the space (hard invariants still apply) |

Role helpers: `server/src/modules/policy/decisionCore.ts`

---

## Wired Sensitive Actions

`enforce()` is the **only enforcement** entry point for `wired_direct` sensitive
actions. `computeDecision`, `engineCheck`, and `checkHardInvariants` must not be
called directly to authorize or perform them. See the non-mutating simulation
exception in the Enforcement section above for the allowed preflight-only site.

### WIRED_DIRECT Actions

The core actions are below; `POLICY_ACTION_REGISTRY` lists every `wired_direct`
action with its `current_enforcement_point`, including `run.spawn_child`,
`project_folder.read`, `agent.config_update`, `input_resource.*`, the
`source.*` / `evidence.*` route actions, the retrieval actions, and the
System Actions dispatched through `systemActions/systemActionDispatcher.ts`.

| Action | Enforcement Point | Decision inputs (context) | Behavior |
|--------|------------------|-----------------------------|----------|
| `runtime.execute` | `RunOrchestrationService` before runtime execution | `agent_status`, `tool_name`, `trigger_origin`, `runtime_key`, risk/sandbox fields | DENY/REQUIRE_APPROVAL prevents execution; records PolicyDecisionRecord + RunEvent; `best_effort` record mode |
| `runtime.use_credential` | `authorizeCredentialSpend`, before any ModelProvider key is resolved or proxy lease minted (provider invocation, lease minting, and the Run executor) | `trigger_origin` of the person, the root Run, or an unattended setup; the live Automation grant; `resource_space_id` | DENY prevents credential resolution; unattended spend with no authorization record is denied, not sent for approval. A CLI runtime resolves no credential here — its login is held by its copy on the execution host (ADR 0016). **fail_closed**. |
| `context.inject_memory` | Runtime Context acquisition (`runtimeContext/productionAcquisition.ts`) via `enforce()` before context assembly | `trigger_origin` | Cross-space DENY; records PolicyDecisionRecord on DENY |
| `context.render_for_runtime` | `runtimeContext/invocationSnapshotService.ts` before adapter execution | `has_context_taint` | Cross-space DENY; records PolicyDecisionRecord on DENY |
| `artifact.persist` | `RunMaterializationService` via `enforce()` before file/row write | `artifact_type`, `visibility`, workspace/project IDs, storage shape | DENY/REQUIRE_APPROVAL blocks file and Artifact row; **fail_closed** durable audit. |
| `proposal.create` | Proposal creation services and Project Folder code patch collection via `enforce()` | `target_visibility`, `target_scope` | Code patch collection uses `force_record=True`. |
| `proposal.apply` | proposal apply acceptance via `enforceProposalApply()` | `payload` scanned for approval-proof flags | Unsupported types deny; role/risk matrix determines supported actions. **fail_closed**. |
| `project_folder.write_patch` | `projectFolders/codePatch.ts` via `enforce()` before any file writes | `proposal_id`, `proposal_type`, `proposal_apply_allowed` | Safe patch summary only; **fail_closed**. |
| `automation.create` | `AutomationService.create()` | membership role and trigger metadata | Creates manual or schedule automations. **fail_closed** audit before creation; then runtime preflight and policy preflight must pass before the Automation row is written. Schedule automations receive an `AutomationCredentialGrant`. |
| `automation.update` | `AutomationService.update()` | membership role | Updates manual or schedule automations. **fail_closed** audit before mutation. |
| `automation.fire` | `AutomationService.fire()` | membership role and `trigger_origin="automation"` | Queues a run for manual or schedule trigger. **fail_closed** audit before queuing; reruns runtime preflight and policy preflight before creating the queued Run. Scheduled automations may use active same-space `AutomationCredentialGrant` pre-authorization. |

### Persisted Policy Effect Contract

`PolicyEffectCatalog` (documented with the policy registry in
`packages/protocol/src/policy.ts`) is a lightweight effect contract,
not a full policy DSL and not an external policy engine. The engine remains
stateless; persisted `Policy` rows are only read by domain-specific enforcement
helpers that are already wired.

Only supported domains may create active `Policy` rows through `policy_change`
proposal application:

| Domain | Enforcement point |
|--------|-------------------|
| `memory.private_placement` | `server/src/modules/policy/decisionCore.ts` |
| `run.user_private_scope` | `server/src/modules/policy/decisionCore.ts` |

Reserved domains (`runtime.execute`, `automation.fire`, `capability.enable`,
`tool_binding.enable`, `deployment.execute`) are vocabulary only. They cannot
create active `Policy` rows and fail closed until a real enforcement point is
wired.

### Automation Policy Preflight

`AutomationService.runPreflight` is a simulation-only preflight layer for
manual and schedule-triggered automations. It dry-runs the policy decisions that would be
encountered before adapter invocation for `runtime.execute`,
`runtime.use_credential`, `context.inject_memory`, and
`context.render_for_runtime`.

It does **not** call `enforce()`, does **not** write
`PolicyDecisionRecord`, does **not** decrypt credentials, and does **not** mutate
Run, Automation, MemoryEntry, Proposal, Policy, Credential, or Artifact rows.
For `runtime.execute` and `runtime.use_credential`, preflight decides from the
same authority real execution uses: the selected `AgentRuntimeProfile`. There is
no credential chain to walk. A `model_provider` Profile names an enabled
Space-selectable ModelProvider and an explicit model, and that one provider is what
credential preflight inspects — metadata only, never a decrypted key. A
`runtime_native` Profile stores no binding and relies on the login its runtime
copy holds on its execution Host, so `runtime.use_credential` is not simulated
for it at all. Nothing falls back to a runtime adapter provider, an AgentVersion
provider, or the Space default: the Space runtime default is a provisioning
template for Profiles that do not exist yet, and neither dispatch nor preflight
reads it. There is no runtime-requirements registry and no
`runtime_requirements_missing` failure; an Agent with no enabled default Profile
fails preflight on that, not on a missing requirements entry.

Policy preflight is not enforcement. Real runtime enforcement, durable audit, and
terminal run failure semantics remain in `RunOrchestrationService`. Automation has
manual and schedule-triggered fire, but no external event trigger or direct
execution path.

### WIRED_VIA_PROPOSAL Actions

These actions are enforced exclusively via the `proposal.apply` gate
(`enforceProposalApply()`). The registry also routes `knowledge.*`, `claim.*`,
`object_profile.*`, `object_relation.*`, the maintenance/diagnostics packets,
`capability.enable` / `disable` / `update`, `skill.import` / `convert`,
`runtime_skill.binding_update`, `source.backfill.start`, and
`source.connection.activate` through proposal application.

| Action | Protected via | Behavior |
|--------|--------------|----------|
| `memory.create` | `proposal.apply` gate | Memory writes require proposal approval |
| `memory.update` | `proposal.apply` gate | Memory updates require proposal approval |
| `memory.archive` | `proposal.apply` gate | Memory archive requires proposal approval |
| `policy.change` | `proposal.apply` gate | Requires admin/owner role through `enforceProposalApply()`; no direct `enforce()` call. **fail_closed**. |

---

## Reserved Actions (lifecycle_status=RESERVED, not yet wired to enforcement)

These actions are registered in the action registry with `lifecycle_status=RESERVED` and
`current_enforcement_point="not_implemented"`. Policy enforcement always denies reserved actions
(DENY with `reason_code="policy_action_not_implemented"`, `audit_code="policy_action_not_implemented"`),
regardless of `default_decision`.
They are **not** wired to any business code call site.
Deployment jobs are instance-admin only (ADR 0020) and do not use
`deployment.propose` / `deployment.execute`.

Unimplemented reserved-action wiring:
[`.agent/plans/unimplemented-from-guides.md`](../.agent/plans/unimplemented-from-guides.md) §22.

| Action | Notes |
|--------|-------|
| `tool_binding.enable` | Tool binding lifecycle not yet wired |
| `context.use_personal_grant` | personal_memory_grants/ does not yet call `enforce()` |
| `artifact.export` | Artifact export surface not yet wired |
| `proposal.approve` | Explicit approval row recording not yet wired |
| `memory.read_private` | Private memory read path not yet wired |
| `memory.promote_shared` | Memory visibility promotion not yet wired |
| `runtime_skill.execute` | Runtime skill execution not yet wired |
| `evidence.export` | Evidence export not yet wired |
| `note.link.create` | Note linking not yet wired |
| `deployment.propose` | Reserved; deployment jobs do not use this action |
| `deployment.execute` | Reserved; deployment jobs are instance-admin only (ADR 0020) |

Actions completely absent from the registry (`agent.delegate`) fail
closed via `unknown_policy_action` DENY if passed to policy evaluation.

---

## Enforced Memory and Context Boundaries

### Memory private placement

`visibility=private` is only permitted in personal spaces. Any attempt to
write a private-visibility memory in a non-personal space is denied by
`check_private_memory_placement()`.

Enforcement: `server/src/modules/policy/decisionCore.ts` and the
memory proposal/apply services.

### Run context isolation

Runtime Context acquisition and memory retrieval enforce `space_id` as a hard filter.
Cross-space memory reads are denied even when the same user instructed both runs.

Enforcement: `server/src/modules/runtimeContext/`, `server/src/modules/memory/`, and
`server/src/modules/policy/decisionCore.ts`

### Personal memory grant egress guard

When a run includes grant-derived personal context:
- `personal_context_block` is injected at runtime only — never persisted
- Exact echoes of the block are redacted from run output before persistence
- Grant-derived artifact/proposal persistence in non-personal spaces requires
  an `egress_review` proposal with explicit granting-user approval
- `raw_private_memory_included=true` always blocks egress (hard invariant)

Enforcement: proposal apply egress checks in `server/src/modules/proposals/applyService.ts`
and run artifact/materialization egress checks in `server/src/modules/runs/`.

### Targeted publication

Publications are explicit target-Space immutable snapshots. Discovery requires
active target membership; import creates an independent private resource and
records snapshot hash/version provenance. Revocation blocks future imports and
does not delete existing copies.

---

## Policy Decision Tracing

Structured policy decision traces are emitted through the server logger
(JSON format). PolicyDecisionRecord provides durable persistence for
audit-required decisions.

Traces never include: memory content, `personal_context_block`, credentials,
or raw output.
