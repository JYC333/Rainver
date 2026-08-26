# Policy and Privacy Boundaries

This document describes the canonical policy enforcement stack and privacy
invariants for rainver. All information here describes the current
enforced state.

---

## Policy Architecture

The policy stack is:

```
HardInvariantGuard
  → PolicyEngine
  → PolicyGateway (composes the above; enforcement entry point)
  → PolicyDecisionRecord (durable audit evidence)
  → optional RunEvent metadata
```

### 1. HardInvariantGuard

Non-overridable security/privacy invariants. These cannot be weakened by
Policy rows, runtime configuration, or caller-supplied context. They run
before PolicyEngine.

Location: `server/src/modules/policy/decisionCore.ts`

### 2. PolicyEngine

Stateless decision engine over canonical actions and built-in rules.
Returns `allow`, `require_approval`, or `deny`.

**Registry default behavior**: When no built-in rule matches, PolicyEngine
returns the action definition's `default_decision` — not a permissive ALLOW.
Unknown actions always return DENY with `audit_code="unknown_policy_action"`.

Location: `server/src/modules/policy/service.ts`

### 3. PolicyGateway

Main service entry point for sensitive actions. Builds context, runs
HardInvariantGuard, calls PolicyEngine, persists PolicyDecisionRecord, and
returns PolicyDecision.

Location: `server/src/modules/policy/gateway.ts`

Business code enforcing wired sensitive actions must use
`PolicyGateway.enforce()` or, for proposal application,
`PolicyGateway.enforceProposalApply()`. Do not call PolicyEngine directly to
authorize or perform a sensitive action.

**Non-mutating simulation exceptions:** Four locations use `PolicyEngine` directly for
preflight simulation — they are not enforcement points and must not persist
`PolicyDecisionRecord`. Real runtime execution still goes through `PolicyGateway`.
- `PreflightService` (`server/src/modules/runs/preflightService.ts`) — dry-run simulation before a run exists.
- `RunService._validate_run_target_agent` / `_validate_adapter_for_target`
  (`server/src/modules/runs/service.ts`) — lightweight preflight during run creation.
- Agent run creation preflight (`server/src/modules/agents/routes.ts` and `server/src/modules/runs/`) —
  non-mutating preflight before queuing a run.
- `AutomationPolicyPreflightService` (`server/src/modules/automations/`) —
  read-only policy preflight simulation for automation-origin runtime gates.
  It uses runtime requirements to decide whether ModelProvider/API-key
  credential policy simulation applies.

All other business code performing enforcement must call `PolicyGateway.enforce()` or
`PolicyGateway.enforceProposalApply()` —
direct `PolicyEngine` or `HardInvariantGuard` usage outside these allowed locations is a
boundary violation detected by `server/test/boundaries.test.ts`.

#### PolicyCheckRequest field semantics

| Field | Role |
|-------|------|
| `context` | **Decision inputs** consumed by `HardInvariantGuard` and `PolicyEngine` rules. Keys are flattened into the guard context. Fields such as `agent_status`, `tool_name`, `trigger_origin`, `derived_from_personal_memory_grant`, `raw_private_memory_included`, `target_visibility`, and `target_space_id` must appear here. |
| `metadata_json` | **Audit-only metadata** written to `PolicyDecisionRecord`. It never grants permission or satisfies approval. Forbidden sentinel fields in this audit bag may still trigger defensive hard DENY, such as `personal_context_block` or approval-proof flags. Dangerous fields are stripped by `sanitize_policy_metadata()`. |
| `payload` | Proposal or policy payload. Only `HardInvariantGuard` reads it (approval-proof flag check for `proposal.apply` / `policy.change`). Not a decision input for any other action. |

### 4. PolicyDecision fields

Every `PolicyDecision` returned by `PolicyGateway`, `PolicyEngine`, or
`HardInvariantGuard` carries three stable machine-readable codes:

| Field | Purpose | Example |
|-------|---------|---------|
| `reason_code` | Stable, machine-readable code for the decision outcome. Consumers can branch on it without parsing `message`. | `"space_boundary"`, `"approved_owner"`, `"hard_invariant_cross_space_memory"` |
| `policy_rule_id` | Identifies the specific rule or invariant that produced this decision. Useful for per-rule analytics. | `"proposal_apply_owner_allow"`, `"hard_invariant_cross_space_memory"` |
| `audit_code` | Stable durable search token persisted in `PolicyDecisionRecord`. Used for audit queries. | `"cross_space_access_denied"`, `"policy_action_not_implemented"` |

**`reason_code` is NOT persisted in `PolicyDecisionRecord`.**
Durable audit relies on `audit_code` (searchable in DB) and `policy_rule_id`
(also stored in `policy_rule_id` column). `reason_code` is an ephemeral
in-process field for runtime branching only.

### 5. PolicyDecisionRecord

Append-only durable evidence of sensitive policy decisions. Persisted for:
- Actions with `audit_required=True`
- Any DENY decision
- Any REQUIRE_APPROVAL decision
- Caller-forced records

Stores `audit_code` and `policy_rule_id` for durable audit queries.
Does **not** store `reason_code` — that is an ephemeral in-process field.

**Never stores**: raw memory content, `personal_context_block`, credentials,
API keys, prompts, patch bodies, stdout/stderr, full file content.
Metadata is sanitized via `sanitize_policy_metadata()` before persistence.
Records required by preferred enforcement paths are written exactly once through
`DurablePolicyAuditWriter`, which writes only `PolicyDecisionRecord` in an
independent transaction. Blocking decisions raise `PolicyGateBlocked`; the HTTP
handler rolls back the request transaction before writing the blocking audit
record. Runtime-local blocked paths call `write_blocked_gate_audit(exc)` once and
fail the operation. A fail-closed durable write failure raises
`PolicyAuditPersistError`, so the sensitive action cannot proceed. No business
object is committed solely to commit policy audit evidence.

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
- `record_failure_mode` — `RecordFailureMode` enum: `BEST_EFFORT` | `FAIL_CLOSED` (see below)

### lifecycle_status

| Value | Meaning |
|-------|---------|
| `WIRED_DIRECT` | Action has a direct `PolicyGateway.enforce()` call site in business code. |
| `WIRED_VIA_PROPOSAL` | Action is protected via `PolicyGateway.enforceProposalApply()` only. |
| `RESERVED` | Registered for vocabulary completeness; no enforcement point. Always fails closed with DENY regardless of `default_decision`. |

Unknown actions fail closed with DENY (`audit_code="unknown_policy_action"`).

### record_failure_mode (`RecordFailureMode` in `packages/protocol/src/policy.ts`)

| Value | Behavior when PolicyDecisionRecord persistence fails |
|-------|-----------------------------------------------------|
| `BEST_EFFORT` | Log a warning and continue — action is not blocked. |
| `FAIL_CLOSED` | Preferred enforcement raises `PolicyAuditPersistError` — the sensitive action must not proceed. |

Actions with `FAIL_CLOSED`: `runtime.use_credential`, `workspace.write_patch`, `artifact.persist`, `proposal.apply`, `policy.change`.

Dynamic escalation to `FAIL_CLOSED` (regardless of per-action default):
- `trigger_origin="automation"` + `audit_required=True` on the action — **regardless of ALLOW/DENY/REQUIRE_APPROVAL**.
- `risk_level=CRITICAL` + `audit_required=True` on the action — **regardless of ALLOW/DENY/REQUIRE_APPROVAL**.
- `trigger_origin="automation"` + non-ALLOW on non-audit-required actions.
- `risk_level=CRITICAL` + non-ALLOW on non-audit-required actions.

**Business-boundary error conversion** — durable audit failures must block sensitive operations:
- `RunOrchestrationService`: converts to terminal failed run with `error_code="policy_decision_record_persist_failed"`. Run never reaches credential resolution, context rendering, or adapter invocation.
- `PgProposalApplyService.accept`: propagates `PolicyAuditPersistError`. Proposal stays pending; proposal side effects are never applied.
- Workspace code patch apply: converts to `CodePatchApplyError` with stable message containing `policy_decision_record_persist_failed`. No files written.
- `RunMaterializationService`: converts to `PersonalMemoryEgressError` with stable message containing `policy_decision_record_persist_failed`. No file or Artifact row written.

### WIRED_VIA_PROPOSAL clarification

`memory.create`, `memory.update`, `memory.archive`, and `policy.change` are **WIRED_VIA_PROPOSAL**. This means:

- There is **no direct** sensitive-action enforcement call for `memory.create`, `memory.update`, `memory.archive`, or `policy.change`.
- Protection is achieved through `PolicyGateway.enforceProposalApply()` in proposal apply acceptance.
- `proposal.apply` is the fail_closed audit and approval gate for all of these actions.
- Run creation, agent run preflight, standalone preflight, and automation preflight use `PolicyEngine` directly for non-mutating simulation — they do not write `PolicyDecisionRecord` rows. Real enforcement is exclusively in `RunOrchestrationService`.
- Automation supports manual and schedule-triggered fire. Its create/update/fire service paths use `PolicyGateway.enforce()` for automation management; create/fire then run runtime preflight and policy preflight simulation. Schedule ticks invoke the same `AutomationService.fire()` path; no external event trigger is implemented. Scheduled automations can carry same-space `AutomationCredentialGrant` pre-authorization.

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

`PolicyGateway` is the **only enforcement** entry point for WIRED_DIRECT sensitive
actions. `PolicyEngine` and `HardInvariantGuard` must not be called directly
to authorize or perform them. See the non-mutating simulation exceptions in the
PolicyGateway section above for the allowed preflight-only sites.

### WIRED_DIRECT Actions

| Action | Enforcement Point | Decision inputs (context) | Behavior |
|--------|------------------|-----------------------------|----------|
| `runtime.execute` | `RunOrchestrationService` before adapter execution | `agent_status`, `tool_name`, `trigger_origin`, `adapter_type`, risk/sandbox fields | DENY/REQUIRE_APPROVAL prevents execution; records PolicyDecisionRecord + RunEvent |
| `runtime.use_credential` | `RunOrchestrationService` before provider credential resolution for runtimes whose credential mode is `model_provider_api_key` | `trigger_origin`, `instructed_by_user_id`; `resource_space_id` from Credential row | DENY/REQUIRE_APPROVAL prevents credential resolution. CLI-profile runtimes use the CLI CredentialBroker path, not ModelProvider API keys. **fail_closed**. |
| `context.inject_memory` | `ContextPrepareService` via `enforce()` before context assembly | `trigger_origin` | Cross-space DENY; records PolicyDecisionRecord on DENY |
| `context.render_for_runtime` | `RunOrchestrationService` before adapter execution | `has_context_taint` | Cross-space DENY; records PolicyDecisionRecord on DENY |
| `artifact.persist` | `RunMaterializationService` via `enforce()` before file/row write | `artifact_type`, `visibility`, workspace/project IDs, storage shape | DENY/REQUIRE_APPROVAL blocks file and Artifact row; **fail_closed** durable audit. |
| `proposal.create` | Proposal creation services and workspace code patch collection via `enforce()` | `target_visibility`, `target_scope` | Code patch collection uses `force_record=True`. |
| `proposal.apply` | proposal apply acceptance via `enforceProposalApply()` | `payload` scanned for approval-proof flags | Unsupported types deny; role/risk matrix determines supported actions. **fail_closed**. |
| `workspace.write_patch` | `apply_code_patch_payload()` via `enforce()` before any file writes | `proposal_id`, `proposal_type`, `proposal_apply_allowed` | Safe patch summary only; **fail_closed**. |
| `automation.create` | `AutomationService.create()` | membership role and trigger metadata | Creates manual or schedule automations. **fail_closed** audit before creation; then runtime preflight and policy preflight must pass before the Automation row is written. Schedule automations receive an `AutomationCredentialGrant`. |
| `automation.update` | `AutomationService.update()` | membership role | Updates manual or schedule automations. **fail_closed** audit before mutation. |
| `automation.fire` | `AutomationService.fire()` | membership role and `trigger_origin="automation"` | Queues a run for manual or schedule trigger. **fail_closed** audit before queuing; reruns runtime preflight and policy preflight before creating the queued Run. Scheduled automations may use active same-space `AutomationCredentialGrant` pre-authorization. |

### Persisted Policy Effect Contract

`PolicyEffectCatalog` (documented with the policy registry in
`packages/protocol/src/policy.ts`) is a lightweight effect contract,
not a full policy DSL and not an external policy engine. `PolicyEngine` remains
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

`AutomationPolicyPreflightService` is a simulation-only preflight layer for
manual and schedule-triggered automations. It dry-runs the policy decisions that would be
encountered before adapter invocation for `runtime.execute`,
`runtime.use_credential`, `context.inject_memory`, and
`context.render_for_runtime`.

It does **not** call `PolicyGateway.enforce()`, does **not** write
`PolicyDecisionRecord`, does **not** decrypt credentials, and does **not** mutate
Run, Automation, MemoryEntry, Proposal, Policy, Credential, or Artifact rows.
For `runtime.execute` and `runtime.use_credential`, preflight uses the same
shared request builders and credential metadata resolver as real execution.
Credential policy preflight inspects only
ModelProvider/Credential metadata and uses the same source priority as execution:
run model provider, runtime adapter provider, agent version provider, then
runtime adapter credential.
Runtime requirements decide whether ModelProvider metadata is relevant at all:
`capability`, `claude_code`, and `codex_cli` do not participate in
ModelProvider/API-key credential checks. To stay consistent with real execution,
automation policy preflight does not treat space default ModelProviders as a
credential source; the credential policy chain is only explicit run provider,
runtime adapter provider, agent version provider, then runtime adapter
credential. CLI-profile runtimes rely on runtime preflight and the CLI
CredentialBroker, not `runtime.use_credential` simulation.
Every wired runtime adapter must have an explicit runtime requirements entry.
Unknown non-empty adapter types fail with a stable configuration error instead
of silently using `model_provider_mode=none`.

Policy preflight is not enforcement. Real runtime enforcement, durable audit, and
terminal run failure semantics remain in `RunOrchestrationService`. Automation has
manual and schedule-triggered fire, but no external event trigger or direct
execution path.

### WIRED_VIA_PROPOSAL Actions

These actions are enforced exclusively via the `proposal.apply` gate
(`PolicyGateway.enforceProposalApply()`).

| Action | Protected via | Behavior |
|--------|--------------|----------|
| `memory.create` | `proposal.apply` gate | Memory writes require proposal approval |
| `memory.update` | `proposal.apply` gate | Memory updates require proposal approval |
| `memory.archive` | `proposal.apply` gate | Memory archive requires proposal approval |
| `policy.change` | `proposal.apply` gate | Requires admin/owner role through `PolicyGateway.enforceProposalApply()`; no direct PolicyGateway call. **fail_closed**. |

---

## Reserved Actions (lifecycle_status=RESERVED, not yet wired to enforcement)

These actions are registered in the action registry with `lifecycle_status=RESERVED` and
`current_enforcement_point="not_implemented"`. `PolicyGateway` always denies reserved actions
(DENY with `reason_code="policy_action_not_implemented"`, `audit_code="policy_action_not_implemented"`),
regardless of `default_decision`. They document intended policy posture for future wiring.
They are **not** wired to any business code call site yet.

| Action | Notes |
|--------|-------|
| `capability.enable` | Capability lifecycle persistence not yet wired |
| `capability.update` | Capability lifecycle persistence not yet wired |
| `tool_binding.enable` | Tool binding lifecycle not yet wired |
| `context.use_personal_grant` | personal_memory_grants/ does not yet call PolicyGateway |
| `workspace.read` | Workspace read APIs do not yet call PolicyGateway |
| `workspace.apply_patch` | Direct workspace patch path not yet wired |
| `artifact.export` | Artifact export surface not yet wired |
| `proposal.approve` | Explicit approval row recording not yet wired |
| `memory.read_private` | Private memory read path not yet wired |
| `memory.promote_shared` | Memory visibility promotion not yet wired |
| `deployment.propose` | Deployment proposal not yet wired |
| `deployment.execute` | Deployment execution not yet wired (critical risk) |

Actions completely absent from the registry (`agent.delegate`) fail
closed via `unknown_policy_action` DENY if passed to `PolicyEngine` or `PolicyGateway`.

---

## Enforced Memory and Context Boundaries

### Memory private placement

`visibility=private` is only permitted in personal spaces. Any attempt to
write a private-visibility memory in a non-personal space is denied by
`check_private_memory_placement()`.

Enforcement: `server/src/modules/policy/decisionCore.ts` and the
memory proposal/apply services.

### Run context isolation

ContextBuilder and MemoryRetriever enforce `space_id` as a hard filter.
Cross-space memory reads are denied even when the same user instructed both runs.

Enforcement: `server/src/modules/context/`, `server/src/modules/memory/`, and
`server/src/modules/policy/decisionCore.ts`

### Personal memory grant egress guard

When a run includes grant-derived personal context:
- `personal_context_block` is injected at runtime only — never persisted
- Exact echoes of the block are redacted from run output before persistence
- Grant-derived artifact/proposal persistence in non-personal spaces requires
  an `egress_review` proposal with explicit granting-user approval
- `raw_private_memory_included=true` always blocks egress (HardInvariantGuard)

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
