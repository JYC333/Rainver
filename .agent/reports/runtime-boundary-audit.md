# Runtime Boundary Audit — Orchestrator ↔ Runtime Contract

Date: 2026-07-16
Status: temporary report (`.agent/reports/` policy applies — not source of truth; delete after consolidation)
Scope: Orchestrator→Runtime invocation boundary only. Task–Run–Attempt model is treated as given
(see `.agent/architecture/EXECUTION_MODEL.md`); it is referenced only where runtime ownership depends on it.

Method: code reading of `server/src/modules/{runs,runtimeAdapters,runtimeHost,runtimeTools,routing,jobs,providers/invocation,agentGroups,systemActions,plans,execution,projectResearch}`.
Every conclusion cites a path/symbol. Statements marked **[inferred]** are extrapolations; everything else is
confirmed code behaviour.

---

## 1. Current runtime boundary reconstruction

### 1.1 Abstraction inventory

| # | Path / symbol | Kind (this audit's vocabulary) | Caller | Input | Output | Persistent state read | Persistent state written | External resources | Invokes models directly | Creates further work |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `runs/orchestrationService.ts` `RunOrchestrationService.executeRun/cancelRun` | **Orchestrator** (run-level) | `runs/agentRunHandler.ts` (job), `runs/routes.ts` (HTTP `/runs/:id/execute`, `/internal/runs/execute`) | `RunExecutionInput` (run_id, space_id, worker_id, command_source; internal callers may add prompt/model/context/adapter_config) | `RunJobResult` | run row, contract snapshot, permission snapshot | run status (running/terminal/waiting/cancelling), run_steps, run_events, sandbox level | sandbox dirs via workspace manager | no | no (delegates to materializer) |
| 2 | `runs/orchestrationService.ts` `RUNTIME_EXECUTORS` | dispatch table Orchestrator→Adapter | `invokeAdapterUnbounded` | `(config, run, input, deps)` | `RunAdapterResultEnvelope` | — | — | — | — | — |
| 3 | `runtimeAdapters/specs.ts` `BUILTIN_RUNTIME_ADAPTER_SPECS` | declarative **Runtime Adapter registry** | routing, orchestration, CLI adapter | adapter_type | `RuntimeAdapterSpec` (trust, sandbox, subagent, invocation templates, limits) | — | — | — | — | — |
| 4 | `runs/managedApiAdapter.ts` `executeManagedApiNoToolAdapter` | **Runtime Adapter** (managed_api: `model_api`, `ts_agent_host`) | RUNTIME_EXECUTORS | run row + prompt/system/context/model/max_tokens | `RunAdapterResultEnvelope` | run row fields (`model_override_json.messages`, `contract_snapshot_json.structured_output_json`) | none directly | model provider via runtime host | yes (via #7) | yes — via #5/#6 tool loops |
| 5 | `systemActions/agentToolGateway.ts` `AgentToolGateway` | tool authorisation + dispatch (policy seam inside managed runtime) | #4 | run + `RuntimeHostExecuteRequest` | `RuntimeHostExecuteResponse` | `agent_versions.tool_permissions_json`, retrieval settings, system-action registry | run_events (`action_invoked/completed`), policy decision records, proposals (via executors) | retrieval services, proposal services | no (passes executor through) | yes — proposal actions, `agent.delegate` |
| 6 | `runs/managedRetrievalTools.ts` `executeWithRetrievalTools`, `runs/managedAgentDelegationTools.ts` `executeWithAgentDelegationTools` | **in-process bounded agent loop** (the real "runtime" of managed runs) | #4 via #5 | request + tool bindings | `RuntimeHostExecuteResponse` | room membership, runs (wait_for_results) | none directly (child runs via `AgentGroupRunService`) | model provider (loop), internal tools | yes (loop ≤4 turns) | yes — `agent.delegate` → policy-gated child run; `agent.wait_for_results` → run suspension |
| 7 | `runtimeHost/service.ts` `executeRuntimeHost` | **model-call host** (single provider call, canonical events) | #4/#6 | `RuntimeHostExecuteRequest` | `RuntimeHostExecuteResponse` + `CanonicalModelEvent[]` | provider command store | token_usage_events (via metering) | model provider HTTP | yes | no |
| 8 | `providers/invocation/invocation.ts` `completeProviderMessages` / `completeProviderChat` / `invokeProviderWithPool` | **model provider invocation** (key pool, provider fallback, task chains) | #7, chat paths, aux tasks | provider_id, model, messages, output_format, metering | text/tool_calls/structured_output/usage | provider + key pool + task policy + fallback chain config | key-pool outcome records, usage events | provider APIs (undici) | yes | no |
| 9 | `runs/vendorCliAdapter.ts` `executeVendorCliAdapter` | **Runtime Adapter + CLI integration** (local_cli: `claude_code`, `codex_cli`, `opencode`) | RUNTIME_EXECUTORS | run row + prompt/context/sandbox_cwd/adapter_config | `RunAdapterResultEnvelope` | credential profiles (broker), runtime tool registry, network profiles, provider binding | sandbox files (`CLAUDE.md`/`AGENTS.md`, subagent-disable config) | spawns external CLI process (local or one-shot Docker) | indirectly (CLI calls its own provider) | the CLI may internally; child runs only via output materialization (#15) |
| 10 | `runs/localCliExecution.ts` `LocalCliCommandExecutor`, `DockerCliCommandExecutor`, `CliProcessRegistry` | **Executor** (process level) | #9 | argv, env, cwd, timeout, stall timeout | `CliExecutionResult` (stdout/stderr/returncode/timed_out) | — | — | OS process, Docker | no | no |
| 11 | `jobs/worker.ts` `JobWorker` + `runs/agentRunHandler.ts` `handleAgentRun` | **Worker / queue entry** | jobs loop (`jobs/workerRuntime.ts`) | `agent_run` job payload (`run_id` only) | `RunJobResult` | jobs table | job status/events; post-terminal research reconcile enqueue | — | no | re-enqueues `project_research_reconcile` on projection failure |
| 12 | `routing/repository.ts` `PgRouteDecisionRepository.routeRun` + `routing/router.ts` `DeterministicRouteSelector` | **routing authority** (runtime + model selection) | orchestrator (`executeRun` step 1) | run row + candidates | routed run row | runtime profiles, credentials, conformance, verification history | `route_decisions` row; stamps `runs.adapter_type / model_provider_id / model_override_json.model / runtime_profile_snapshot_json` | — | no | no |
| 13 | `runs/supervisor.ts` `PgRunSupervisor` | **retry authority** | `PostRunFinalizationService` | terminal run + evaluation | `SupervisorDecision` | attempts, usage events, route decisions | `run_supervisor_decisions`, requeues run, enqueues `agent_run` job | — | no | yes — next attempt |
| 14 | `runs/finalizationService.ts` `PostRunFinalizationService` | evaluation/finalization authority | materializer `finalizeRun` / worker recovery | terminal run | `RunFinalizationRecord` | steps/events/verification | run_evaluations, run_finalizations, run_events, evolution signals | — | no | indirectly (calls #13) |
| 15 | `agentGroups/service.ts` `AgentGroupRunService.spawnChildRun` + `agentGroups/runtimeDelegationMaterializer.ts` | **child-run spawn authority** | #6 tool, materializer (CLI structured output `runtime_delegations`) | delegation input (target, instruction, budget/context hints) | delegation record + child run id | group membership, policy | delegations, child `runs` rows (queued), jobs | — | no | yes — that is its job |
| 16 | `projectResearch/orchestrator.ts` `ProjectResearchOrchestrator` | **domain workflow orchestrator** | routes, job handlers, `handleAgentRun` post-hook | operation state | — | research operations/workflows | operations, workflow stages; creates runs via `createQueuedRunWithBudgetAdmission` + enqueues `agent_run` | — | no | yes — stage runs |
| 17 | `plans/executionService.ts` + `execution/executionGraphScheduler.ts` | plan/workflow graph orchestration | routes, finalization reconciler | plan/workflow graph | node scheduling decisions | plan nodes, runs | node states, node runs | — | no | yes — node runs |

### 1.2 Terminology inconsistencies

- **"Runtime" is used for five different things**: the adapter type (`RuntimeAdapterType`), the executable-version registry (`runtimeTools/` — CLI binaries, not model tools), the provider-call wrapper (`runtimeHost/` — really a *model call host*, no tools of its own), the routing candidate (`runtime_profile`), and the conformance target (`runtimeConformance/`). None of these is the thing that actually plans/loops for managed runs — that lives in `runs/managed*Tools.ts` with no "runtime" in the name.
- `executeManagedApiNoToolAdapter` is misnamed: it routes every managed run through `AgentToolGateway`, which enables retrieval tools, delegation tools, and proposal actions (`managedApiAdapter.ts:81`). The "NoTool" claim is only true for the innermost `executeRuntimeHost` call when `tool_mode: "disabled"`.
- "Adapter" covers both the thin protocol wrapper (managedApiAdapter) and the full CLI lifecycle manager (vendorCliAdapter, which owns credentials, sandbox files, provider binding, and process supervision).
- `orchestrationService.ts` is the run executor; the *product-level* orchestrators (ProjectResearch, Plan/Workflow, AgentGroup room) live elsewhere and are not named orchestrators consistently (only ProjectResearch is).

---

## 2. Representative execution trace

Path traced: a queued managed (`ts_agent_host`) execution Run with delegation tools, from job claim to persisted result. (CLI differences noted inline.)

1. **Dispatch** — `JobWorker.processOne` (`jobs/worker.ts`) claims the `agent_run` job; `handleAgentRun` (`runs/agentRunHandler.ts:38`) extracts only `run_id` (`task_id`-style create-and-execute payloads are rejected) and calls `RunOrchestrationService.executeRun` with `command_source: "job"`.
2. **Lock + admission** — `executeRun` skips coordinator/terminal/waiting runs, takes `tryAcquireExecutionLock`, then:
3. **Runtime selection** — `routeResolver.routeRun` (`routing/repository.ts:42`): deterministic hard filters + scoring over runtime profiles (`routing/router.ts`), persists a `route_decisions` row per attempt, and stamps `runs.adapter_type`, `runs.model_provider_id`, `model_override_json.model = selected.model_name`, `runtime_profile_snapshot_json`. Retry attempts exclude tried profiles and are constrained to the persisted fallback chain.
4. **Model selection** — decided in step 3 (profile's `model_name` + `model_provider_id`). **Gap (confirmed):** the managed adapter never reads the stamped model — see §9-V1.
5. **Contract gate** — `checkRunDispatchContract` (budget admission from the immutable `contract_snapshot_json`, `runs/contractSnapshot.ts`, `runs/budgetEnforcement.ts`); rejection is written as a terminal failed run by the orchestrator.
6. **Policy gate** — `enforceRuntimePolicy` (`orchestrationService.ts:915`): `runtime.execute` and `runtime.use_credential` via the policy service; sandbox level re-derived from contract risk (`resolveSandboxLevelForRuntime`); HTTP callers' `adapter_config` is discarded (`callerConfig = {}` when `command_source === "http"`, and `runs/routes.ts:166` accepts no execution parameters from the body); approval-required decisions pause the run (`waiting_for_review`).
7. **Request construction** — `prepareRuntimeContext` provisions the sandbox (ephemeral dir or worktree via `RunWorkspaceManagerPort`) and calls `ContextPrepareService.prepare`, which owns prompt/context packaging and vendor-file rendering decisions. The result is merged into the input by `inputWithPreparedRuntime` (`runs/orchestrationResults.ts:150`). There is **no single typed runtime request object** — the de facto request is `RunRecord` + `RunExecutionInput` + `contract_snapshot_json` + `adapter_config`, interpreted by each adapter.
8. **Invocation** — `invokeAdapter` clamps the timeout to the contract's `max_duration_seconds` and dispatches through `RUNTIME_EXECUTORS[spec.executor_family]`.
   - Managed: `executeManagedApiNoToolAdapter` builds a `RuntimeHostExecuteRequest` (system prompt composed from run + context + room identity preamble) → `AgentToolGateway.execute` resolves tool bindings fail-closed (AgentVersion `tool_permissions_json` ∩ run `capabilities_json`; registry visibility filter) → tool loop (≤4 turns) → each model turn goes through `executeRuntimeHost` → `completeProviderMessages` (task chain → provider fallback chain → per-key pool with one same-key retry).
   - CLI: `executeVendorCliAdapter` grants a run-scoped credential home, writes vendor context + subagent-disable config into the sandbox, resolves the pinned CLI tool version, binds the provider (env such as `ANTHROPIC_MODEL`, proxy lease), renders argv from the spec template, and spawns the process registered in `CliProcessRegistry`.
9. **Internal planning** — Managed: the model plans within the 4-turn tool loop; every governed action produces `action_invoked/action_completed` run events and a fail-closed policy decision record. CLI: planning is entirely internal to the vendor binary (`observability_level: "opaque"` for claude_code/codex in `runtimeAdapters/specs.ts`); the system sees stdout/stderr and the git diff afterwards.
10. **Subagents / child work** — Managed: `agent.delegate` → `AgentGroupRunService.spawnChildRun` (policy preflight, budget clamp, durable delegation + queued child run). CLI: in-runtime subagents are config-disabled for claude_code (deny `Task`) and opencode (locked agent permissions) via `ensureRuntimeSubagentsDisabled`; **codex_cli has no disable mechanism** (spec: `unknown`). Structured `runtime_delegations` in adapter output are converted post-hoc into policy-gated child runs by `AgentGroupRuntimeDelegationMaterializer`.
11. **Progress** — RunSteps (`adapter_started`) and RunEvents (`adapter_invoked`, `sandbox_created`, `action_*`, `validation_*`, `artifact_ingested`, `patch_collected`, `adapter_completed`) are written **only by the orchestrator/gateway**, never by adapters directly. Adapters return one terminal envelope; there is no streaming progress channel from the adapter to the orchestrator.
12. **State transitions** — only `RunOrchestrationService` (via `PgRunRepository`) moves the Run: `markRunRunning` → `markRunTerminal` / `markRunWaitingForDependency` / `markRunWaitingForReview`. A guarded `markRunTerminal` returning null means a concurrent cancel owns the terminal write and the late adapter result is discarded (`orchestrationService.ts:615`).
13. **Completion/failure decision** — `terminalStatusFromAdapter` on the envelope, downgraded to `degraded` on materialization/finalization errors; `PostRunFinalizationService.finalize` produces the evaluation; `PgRunSupervisor` decides retry/reroute/human-review/budget-exceeded and is the **only** path back from terminal to queued.
14. **Result storage** — `runs.output_text/output_json/error_json/usage_json/exit_code` (latest attempt) + materialized artifacts/proposals/patches via `RunMaterializationService`; verification results appended per attempt.

```
JobWorker ──agent_run──▶ RunOrchestrationService.executeRun
   │ lock → routeRun (runtime+model stamped) → contract gate → policy gate
   │ prepareRuntimeContext (sandbox + ContextPrepareService)
   ├─ managed_api ▶ executeManagedApiNoToolAdapter ▶ AgentToolGateway
   │                 ▶ tool loop (≤4 turns) ⇄ executeRuntimeHost ⇄ completeProviderMessages
   │                 │        └─ agent.delegate ▶ AgentGroupRunService.spawnChildRun (child run queued)
   │                 └─ envelope
   ├─ local_cli   ▶ executeVendorCliAdapter ▶ Local/DockerCliCommandExecutor (vendor CLI process)
   │                 └─ envelope (stdout parse, usage: null)
   ▼
 markRunTerminal → materialize/verify → finalizeRun → PostRunFinalization → Supervisor (retry?) → reconcilers
```

---

## 3. Responsibility ownership audit

| Responsibility | Current owner | Status | Recommended owner |
|---|---|---|---|
| Selecting the runtime | `routeRun` + `enforceRuntimePolicy` (run row authoritative; HTTP `?runtime` override rejected, `runs/routes.ts:160`) | **clearly owned** | keep |
| Selecting the model | Split: `routeRun` stamps it; managed adapter ignores the stamp; provider fallback/task chains may substitute (`invocation.ts:1160–1325`) | **duplicated + owned by wrong layer** | routing decides; adapter must honor; invocation may only fall back within an authorised list and must report actuals |
| Constructing execution context | `prepareRuntimeContext` + `ContextPrepareService`; CLI vendor-file write in adapter per spec | **clearly owned** | keep |
| Reducing/truncating context | ContextPreparer (upstream); plus adapter-side stdout truncation at 12 000 chars (`vendorCliAdapter.ts:618`) and tool-result snippet caps (`managedRetrievalTools.ts:60–61`) | **implicitly owned** (evidence truncation vs context reduction conflated) | orchestrator/context layer for context; adapters may truncate *evidence* only, declared in the contract |
| Selecting permitted tools | `AgentToolGateway` fail-closed intersection (AgentVersion ∩ run capabilities ∩ registry visibility) | **clearly owned** | keep |
| Enforcing permissions | Policy service at orchestrator (`runtime.execute/use_credential`) + per-action `PolicyGateway` in gateway; CLI `permission_bypass` gated by `runtime_policy_json` key at render time (`cliCommandRendering.ts:115`) | **clearly owned** | keep |
| Deciding decomposition is complete | Plan/Workflow graph (`ExecutionGraphScheduler`) and domain orchestrators | **clearly owned** | keep |
| Creating child tasks/runs | `AgentGroupRunService.spawnChildRun` (policy-gated), reachable via tool or output materialization | **clearly owned** | keep |
| Invoking internal subagents | Managed: none. CLI: disabled by config for claude_code/opencode; **codex_cli uncontrollable** | **backend-specific without justification** (codex) | spec must declare a working disable mechanism or the adapter stays low-trust/non-default |
| Retrying a failed model call | `invokeProviderWithPool` (same-key retry once, key rotation) + provider fallback chain | **implicitly owned** (adapter layer) | acceptable for idempotent model calls, but must be bounded by an orchestrator-declared allowance and reported |
| Retrying an Attempt | `PgRunSupervisor` only (durable decision, attempt caps, cost caps) | **clearly owned** | keep |
| Updating Attempt state | run repository CTE dual-write, orchestrator-triggered | **clearly owned** | keep |
| Updating Run state | `RunOrchestrationService` via repository, guarded against concurrent cancel | **clearly owned** | keep |
| Classifying failures | `PostRunFinalizationService.mapFailure` + `classifyProviderFailure` (provider layer) + adapter error codes | **duplicated** (three taxonomies) but layered coherently | keep layering; keep the error-code strings as the single join key |
| Validating output | `VerificationEngine` (orchestrator step) + structured-output schema validation in invocation layer | **clearly owned** (schema check at the provider boundary is correct placement) | keep |
| Determining objective completion | evaluation/verification (`outcomeForRun`), not the adapter's `success` bit alone | **clearly owned** | keep |
| Cancelling execution | `cancelRun` two-phase (cancelling → SIGTERM → waitForExit → SIGKILL → terminal); managed API calls are **not aborted**, only their result discarded | **clearly owned for CLI; implicitly owned for managed** | pass an abort signal into `executeRuntimeHost`/undici fetch |
| Recording usage and cost | Managed: metering in `completeProviderMessages` → `token_usage_events`. CLI: `usage: null` (`vendorCliAdapter.ts:467`) | **clearly owned (managed) / unowned (CLI)** | adapter must return usage (or an explicit estimate) for every attempt |

---

## 4. Runtime autonomy classification

Capability matrix (✔ = can do today, ✘ = cannot, ◐ = partially/config-dependent):

| Capability | model_api / ts_agent_host (managed) | claude_code | codex_cli | opencode |
|---|---|---|---|---|
| Reinterpret / change objective | ✘ (prompt from run row; system preamble additions are fixed server text) | ◐ inside sandbox, invisible | ◐ | ◐ |
| Generate own multi-step plan | ◐ (≤4 tool turns) | ✔ (opaque) | ✔ (opaque) | ✔ (structured events) |
| Create hidden subtasks | ✘ (delegations are durable rows) | ✘ (Task tool denied via `.claude/settings.json`) | ✔ (no disable mechanism) | ✘ (locked agent config) |
| Invoke subagents | ✔ visible (`agent.delegate` → child run) | ✘ (config) | ✔ hidden | ✘ (config) |
| Select or switch models | ✘ by intent — but provider fallback below it can (§5-H1) | ◐ model passed by `--model`/env; CLI could ignore **[inferred]** | model via run-scoped provider config only | ◐ `--model` flag |
| Use unauthorised tools | ✘ (gateway fail-closed) | ◐ full workspace access within sandbox; bypass flag policy-gated | ◐ (`--sandbox workspace-write`) | ◐ (webfetch denied, edit/bash allowed by locked profile) |
| Retry autonomously | ◐ key/provider level + first-turn tool degrade | ✘ (single process) | ✘ | ✘ |
| Write Task/Run/Attempt persistence | ✘ (returns envelope only) | ✘ (no DB access; sandbox only) | ✘ | ✘ |
| Update terminal execution state | ✘ | ✘ | ✘ | ✘ |
| Side effects without structured reporting | ✘ (actions evented) | ✔ within worktree (only git diff observed) | ✔ | ◐ (JSONL events) |
| Return only unstructured final answer | ◐ (structured contract enforced when declared) | ✔ (plain stdout) | ✔ | ✘ (JSONL parsed) |
| Continue after cancellation | ◐ provider HTTP not aborted (result discarded) | ✘ (SIGTERM→SIGKILL, exit confirmed) | ✘ | ✘ |

**Classification**

- `model_api` / `ts_agent_host`: **bounded agent.** Bounded objective, authorised tool list, turn cap, no state writes, visible child work. The one leak is model-identity drift via the provider fallback layer.
- `claude_code`: **bounded (partially opaque) agent.** Subagents disabled, sandboxed, killable, timeout- and contract-capped; but internal planning, tool usage, and token usage are invisible (`observability_level: "opaque"`, `usage: null`). Not an "independent orchestrator" because it cannot create durable work or touch persistence.
- `codex_cli`: **partially opaque orchestrator.** Same sandbox/kill/timeout bounds, but internal subagent delegation is uncontrollable and invisible (`subagent_disable_mechanism: "unknown"`), while the adapter is `enabled_by_default: true`. Mitigation exists only via trust ranking (baseline low; conformance required for risk > low, `routing/router.ts:96`).
- `opencode`: **bounded agent** (closest CLI to the intended contract: locked agent profile, JSONL event stream, session resume declared).
- `gemini_cli`, `capability`, `custom`: **insufficient evidence** — `implementation_status: "planned"`, executors return `runtime_adapter_not_implemented`.

---

## 5. Hidden orchestration detection (top 5)

**H1. Provider fallback + task chains re-decide provider/model below routing.**
`providers/invocation/invocation.ts:1160–1214` (`completeProviderChat` walks `fallback_provider_ids`; fallback providers serve *their own default model*) and `:1293–1325` (task chains reroute by task name).
Hidden decision: which provider and model actually execute the routed attempt.
Why it doesn't belong there: C2 routing persists a `route_decisions` row asserting the selected provider/model; the invocation layer can silently execute elsewhere with only `token_usage_events` recording the truth. Structured-output runs partially guard this (task chains skipped when `output_format` present, `invocation.ts:1293`), and fallback intent is documented for chat — but run execution flows through the same path.
Consequence: run evidence (`route_decisions`, `runtime_profile_snapshot_json`) can disagree with what executed; supervision/verification statistics attribute outcomes to the wrong route.

**H2. The managed tool loop performs an autonomous retry-with-downgrade.**
`runs/managedRetrievalTools.ts:277–307` and `runs/managedAgentDelegationTools.ts:208–223`: on first-turn `runtime_tool_provider_unsupported`, the adapter re-invokes the model with all tools stripped and returns that as the run result.
Hidden decision: "this objective is still worth executing without its authorised tools."
Consequence: a run whose value depended on retrieval/delegation quietly completes as a plain completion; the only trace is a metadata summary (`agent_room_tool_provider_unsupported`), no run event, no policy decision.

**H3. Planning prompts live in the runtime layer.**
`delegationSystemPrompt` (`managedAgentDelegationTools.ts:659`) and the retrieval preamble inject delegation/planning instructions into the system prompt inside the adapter.
Why tolerable: the text is fixed server-owned guidance for server-owned tools, not vendor config. Why it still matters: prompt-driven tool steering is invisible to the contract snapshot; two runs with identical contracts can behave differently as this text evolves, with no versioned record. Consequence: non-reproducible behaviour drift across releases.

**H4. Worker-side domain projection after terminal state.**
`runs/agentRunHandler.ts:63–86`: the job handler calls `ProjectResearchOrchestrator.reconcileCompletedRun` after the run authority commits, and enqueues `project_research_reconcile` on failure.
Hidden decision: advancing the parent research operation from inside the generic run worker.
Why acceptable-but-watchlisted: it is explicitly post-authority, idempotent, and failure-isolated — but it is a second copy of the "notify domain orchestrator on terminal" pattern that `PostRunFinalizationService` already provides via `executionGraphReconciler`. Consequence: two reconciliation entry points to keep consistent.

**H5. Run suspension driven by model tool calls.**
`agent.wait_for_results` (`managedAgentDelegationTools.ts:394–494`) returns a `suspend` response whose `waiting_for_results` payload makes the orchestrator move the run to `waiting_for_dependency` (`orchestrationService.ts:481–549`).
Hidden decision: the model decides that the run pauses.
Why it (mostly) belongs: the pause is applied by the orchestrator via a guarded repository write, dependencies are validated against the same room/root run, and resume is server-owned. The residual risk is that the pause protocol is defined only by adapter-envelope convention (`waitingForDependencyFromAdapter`), not by the contract.

---

## 6. Recommended minimal runtime contract

The pieces already exist (`RunExecutionInput`, `PreparedRuntimeContext`, `ResolvedRuntimePolicy`, `contract_snapshot_json`, `RunAdapterResultEnvelope`); the recommendation is to consolidate them into **one typed request/response pair** at the `RUNTIME_EXECUTORS` boundary — not to invent new machinery.

### 6.1 RuntimeExecutionRequest (assembled once in `RunOrchestrationService`, after policy + routing + context prep)

| Field | Created by | Runtime may modify | Persisted | Required |
|---|---|---|---|---|
| `run_id`, `space_id`, `attempt_number` | orchestrator (from run row + attempt) | no | already (runs/run_attempts) | required |
| `objective` (prompt + instruction + system_prompt) | run creation + ContextPreparer | no (may *append* declared fixed preambles; see §7-P2) | yes (run row) | required |
| `contract_ref` (immutable `contract_snapshot_json`: acceptance, structured_output, risk, budgets) | run creator | no | yes (run row) | required |
| `model_binding` { provider_id, model, fallback_provider_ids allowed for this run (possibly empty) } | routing (`routeRun`) | no — must execute exactly within the list | yes (`route_decisions` + run stamp) | required |
| `tool_authorisation` (resolved tool bindings incl. scopes/side-effect levels) | AgentToolGateway resolution, moved before invocation | no (may use a subset) | should be (currently only implicit in events) | required (may be empty) |
| `context_package` (context_text / rendered vendor file flag / sandbox_cwd) | `prepareRuntimeContext` | no | partially (run events) | required for CLI, optional for managed |
| `output_schema` (from `structured_output_json`) | run creator | no | yes | optional |
| `limits` { timeout_ms (contract-clamped), max_tokens, stall_timeout } | orchestrator (`invokeAdapter` clamp) | may tighten, never widen | yes (contract) | required |
| `cancellation` (process-registry handle for CLI; abort signal for managed — **new**) | orchestrator | must honor | n/a | required |
| `idempotency` { attempt-scoped id for side-effectful tool calls } | orchestrator | no | yes (policy decision records) | required when tools enabled |
| `policy_constraints` (permission_bypass allowance, credential profile, network profile) | `enforceRuntimePolicy` | no | yes (permission snapshot / events) | required |
| `trace` { worker_id, job_id, root/parent run ids, run_group_id } | worker + run row | no | yes | required |

Explicitly **not** included: retry counts (Supervisor-owned), routing hints (routing-owned), free-form `adapter_config` from callers (already discarded for HTTP; internal callers should migrate into the typed fields above).

### 6.2 RuntimeExecutionResponse (evolve `RunAdapterResultEnvelope`, do not replace)

| Field | Notes | Required |
|---|---|---|
| `status` (`succeeded` / `failed` / `suspended:waiting_for_dependency`) | replaces the implicit `success` + `waiting_for_results` sniffing | required |
| `output_text` / `output_json` (schema-validated when contract declares one) | exists | required |
| `artifacts` / materialization inputs | exists (materializer parses output) | optional |
| `model_calls[]` { provider_id_actual, model_actual, usage, finish_reason } | **new** — closes H1; source data already exists in `invokeProviderWithPool` | required for managed; best-effort for CLI |
| `tool_calls[]` summaries | exists (`agent_room_tool_calls`, retrieval summaries) — promote to a typed field | required when tools enabled |
| `external_side_effects[]` (spawned delegations, proposals) | exists as durable rows; envelope should reference their ids | required when present |
| `failure` { code, message, retryable_hint } | codes exist; retryability today is a Supervisor-side static set (`RETRYABLE_ERROR_CODES`) — adapter hint stays advisory | required on failure |
| `unresolved_uncertainty` (e.g. tools degraded, verification not runnable) | **new**, closes H2's silence | optional |
| `usage` (aggregate) | exists; must become non-null for CLI (see §9-V3) | required |
| `child_work_proposals[]` (`runtime_delegations` contract) | exists (`RuntimeDelegationsOutputSchema`) | optional |

**Channel separation** (current state is already correct; keep it explicit):
- *Progress events*: RunEvents written by orchestrator/gateway only.
- *Terminal response*: the envelope, applied exactly once under the terminal-write guard.
- *Execution logs*: `adapter_log_json` + redacted stdout/stderr (evidence, truncation allowed).
- *Persistent domain state*: only via materializer/proposals/delegation services — never from adapter code.

---

## 7. Explicit runtime prohibitions

Derived from what the code already enforces (E = enforced today) or should (G = gap):

| # | A Runtime must not… | Enforcement point | Status |
|---|---|---|---|
| P1 | write to `runs` / `run_attempts` / `run_steps` / `run_events` / jobs | adapters receive no repository handle; all writes via orchestrator/gateway | E |
| P2 | modify the run objective (prompt/instruction) — fixed server preambles must be versioned and declared | orchestrator constructs prompt; **preamble versioning missing** (H3) | E / G |
| P3 | execute on a provider/model outside the routed binding + authorised fallback list | today only structured-output runs are protected (`invocation.ts:1293`); managed adapter drops the stamped model | **G** (§9-V1/V2) |
| P4 | expand tool permissions beyond the resolved bindings (incl. `permission_bypass` without `runtime_policy_json.allow_permission_bypass`) | `AgentToolGateway` fail-closed; `cliCommandRendering.ts:115` render-time check | E |
| P5 | spawn sub-work except through `AgentGroupRunService.spawnChildRun` (tool or `runtime_delegations` output) | delegation tools + materializer; CLI subagent-disable configs; **codex_cli hole** | E / G |
| P6 | mark objective-level success (only `success` of its own execution; evaluation/verification decide outcome) | `PostRunFinalizationService.outcomeForRun` | E |
| P7 | retry an Attempt or requeue itself | only `PgRunSupervisor` returns terminal → queued | E |
| P8 | retry non-idempotent side effects (tool calls) autonomously — model-call retries limited to transport/key rotation on the same request | key-pool loop only re-sends the model request; tool dispatch is single-shot per call id | E |
| P9 | continue executing after cancellation confirmation | CLI: process registry SIGTERM/SIGKILL + confirmed exit; managed: **no abort propagation** | E / G |
| P10 | exceed the contract time/cost budget | timeout clamp (`invokeAdapter`), CLI timeout min with contract, cost cap at Supervisor; CLI cost invisible | E / G (V3) |
| P11 | emit unredacted secrets/evidence | `evidenceRedaction` applied in both adapters | E |
| P12 | let the model set child-run budgets — delegation budget hints must be server-clamped | `delegationBudgetLimits` in `AgentGroupRunService` (`service.ts:120`) | E |

---

## 8. External CLI and agent-backend treatment

Based on the three implemented integrations (`claude_code`, `codex_cli`, `opencode`):

- **Can an autonomous CLI satisfy the same Runtime contract?** Yes, and it already (mostly) does: same envelope, same policy gate, same sandbox provisioning, same terminal-write guard. The contract fields it cannot honestly fill (`model_calls`, `tool_calls`, `usage`) must be declared per adapter — the `RuntimeAdapterSpec` observability/usage fields are exactly that declaration and should become contract-level requirements rather than descriptive metadata.
- **Runtime, bounded agent, or external orchestrator?** Treat each CLI as a **low-trust bounded agent behind the Runtime contract**, never as an external orchestrator: it gets one bounded objective per Attempt, one sandbox, one credential grant, one timeout. The repo's stance (baseline trust `low`, C3 conformance required to reach `medium`, `ROUTING.md`) matches this and should stay.
- **Which internal planning steps must it expose?** Minimum: a structured event stream when the binary supports one (opencode JSONL is already parsed, `parseOpenCodeOutput`); otherwise the adapter must mark the run `observability_level: opaque` and routing must keep such runtimes out of risk > low (already enforced via trust/conformance filters).
- **Must subagent calls be system-visible?** Yes. Two acceptable forms exist today: disabled entirely (claude_code/opencode configs) or proposed as `runtime_delegations` structured output → materialized child runs. Invisible internal delegation (codex_cli) fails the contract; see §9-V5.
- **Can it choose models internally?** No. The model must arrive via the run-scoped provider binding (`runtimeProviderBinding.ts` env/config, codex per-run provider config) and the CLI must not carry ambient credentials that would let it call other providers — ADR 0008 channel isolation plus the run-scoped temp HOME already provide this.
- **Can it persist execution state directly?** No, and it can't today: it only touches the sandbox worktree; results enter the system via envelope parsing, patch collection, and materialization.
- **Minimum telemetry:** exit code, redacted stdout/stderr, rendered (redacted) argv, tool version, credential/profile evidence — all present in `cliResultEnvelope` — **plus usage, which is currently `null`** (V3).
- **When should the system refuse to use it?** Already implemented and correct: conformance failed (hard filter), risk > low without C3 pass, critical risk without one-shot Docker support, no explicit credential profile, docker mode with network-requiring bindings (`docker_network_policy_denied`). Add: refuse when the contract declares a structured output schema and the adapter's `structured_output` is `none`/`unknown` **[currently not checked at routing]**.

---

## 9. Five most important boundary violations

**V1. Managed adapter drops the routed model.**
- Path: `runs/managedApiAdapter.ts:105` (`runtimeHostRequest` sets `model: input.model ?? null`; `input.model` is never populated on the job path) vs `routing/repository.ts:136–141` (router stamps `model_override_json.model`). Contrast: the CLI path honors it (`runs/runtimeProviderBinding.ts:135–138`).
- Current behaviour: managed runs execute on the provider's default model regardless of the routed profile's `model_name`.
- Violated responsibility: model selection (router decides, runtime executes).
- Risk: route decisions, cost estimates, and verification pass-rate statistics attribute results to a model that never ran; profile-level model pinning silently ineffective.
- Smallest correction: in `runtimeHostRequest`, fall back to `model_override_json.model` before null. DB change: none. Urgency: **immediate**.

**V2. Provider fallback substitutes provider/model below the routing authority without run-level evidence.**
- Path: `providers/invocation/invocation.ts:1160–1214`, task chains `:1293–1325`.
- Violated responsibility: model/runtime selection + structured reporting.
- Risk: run executed on fallback provider B while `route_decisions`/`runtime_profile_snapshot_json` assert provider A; debugging and trust/pass-rate learning corrupted.
- Smallest correction: thread the actual `{provider, model}` from `invokeProviderWithPool` through `RuntimeHostExecuteResponse.adapter_metadata` (field already exists) and have the orchestrator append a run event when actuals differ from the stamp; optionally a contract/policy flag restricting run executions to the routed provider (structured-output runs already behave this way). DB change: none. Urgency: **next related change**.

**V3. CLI attempts have no usage/cost, so budget supervision is blind to them.**
- Path: `runs/vendorCliAdapter.ts:467` (`usage: null`); `runs/supervisor.ts:281–287` sums `token_usage_events` that CLI attempts never write.
- Violated responsibility: recording usage and cost.
- Risk: `max_cost` contract caps are unenforceable for local-CLI routes; retries can spend indefinitely up to attempt caps.
- Smallest correction: parse usage from structured output where available (opencode JSONL; claude_code `--print` JSON output format) and write a `token_usage_events` row (estimated accuracy flagged per spec `usage_accuracy`). DB change: none (table exists). Urgency: **next related change**.

**V4. Adapter-internal degrade retry silently strips authorised tools (H2).**
- Path: `runs/managedRetrievalTools.ts:288–307`, `runs/managedAgentDelegationTools.ts:208–223`.
- Violated responsibility: retrying a model call *with changed capabilities* is an orchestration decision.
- Risk: runs that required retrieval/delegation succeed as plain completions; downstream consumers (research synthesis, room coordination) act on weaker output with no reviewable signal.
- Smallest correction: keep the degrade (availability is valuable) but emit a run event (`adapter_completed` status `warning` or an `action_completed` with `error_code`) and set an `unresolved_uncertainty` field in the envelope so evaluation can classify it. DB change: none. Urgency: **next related change**.

**V5. codex_cli internal subagents are uncontrollable yet the adapter is enabled by default.**
- Path: `runtimeAdapters/specs.ts:336–337` (`subagent_disable_mechanism: "unknown"`, no `subagent_disable_config`, `enabled_by_default: true`); `ensureRuntimeSubagentsDisabled` no-ops for it (`runtimeAdapters/subagentConfig.ts:16–25`).
- Violated responsibility: hidden subagent execution / invisible parallel orchestration.
- Risk: a default-enabled runtime can fan out internal agents with the run's credential grant and time budget, invisible to run evidence.
- Smallest correction: either materialize a working disable config (as done for opencode) or flip `enabled_by_default: false` until one exists; routing trust gates already contain the blast radius for risk > low. DB change: none. Urgency: **next related change**.

(Excluded as low-impact: `orchestrationService.ts` exceeding the repo's file-size guidance; `NoToolAdapter` naming; opencode's synthetic credential grant fallback in `grantCredential` — worth a comment, not a boundary break.)

---

## 10. Minimal adoption sequence

**Step 1 — Honor the routed model and formalize one request type.**
- Paths: `runs/managedApiAdapter.ts` (read `model_override_json.model`), `runs/orchestrationService.ts` (fold `ResolvedRuntimePolicy` + `PreparedRuntimeContext` + contract/limits into one exported `RuntimeExecutionRequest` passed to `RUNTIME_EXECUTORS`), `packages/protocol` if the type is shared.
- Compatibility: envelope shape unchanged; job/HTTP entry unchanged.
- Tests: real-DB test asserting a managed run with a profile `model_name` invokes the provider with that model (extend `server/test/providersStructuredOutputToolFallback.test.ts` fixtures or a new runs orchestration test); existing orchestration tests stay green.
- Done when: no adapter reads raw `RunRecord` fields for values the request carries.
- Risk: low — additive typing plus one fallback read.

**Step 2 — Report model actuals through the envelope.**
- Paths: `providers/invocation/invocation.ts` (return actual provider/model per call), `runtimeHost/service.ts` (surface in `adapter_metadata`/`model_calls`), `runs/orchestrationService.ts` (run event on mismatch with the route stamp).
- Compatibility: fallback behaviour itself unchanged.
- Tests: unit test forcing a fallback (fake store) asserting actuals in the response; run-event assertion in orchestration test.
- Done when: every terminal managed run's evidence names the executing provider/model.
- Risk: low.

**Step 3 — Constrain fallback for run executions.**
- Paths: `providers/invocation/invocation.ts` (accept an allowed-provider list / `fallback: "deny"` from the runtime-host metering context), `runtimeHost/service.ts`, contract `policy_context_json`.
- Compatibility: chat and auxiliary-task paths keep full fallback; only stamped run executions narrow.
- Tests: run with `fallback: deny` fails with `provider_unavailable` instead of switching; structured-output behaviour unchanged.
- Done when: a routed run can only execute inside its authorised provider list, and the Supervisor's `retry_fallback_route` becomes the sole cross-provider path.
- Risk: medium — availability regression if profiles were implicitly relying on invocation-layer fallback; mitigate by defaulting to "allow but report" (Step 2) and flipping per-contract.

**Step 4 — CLI usage + codex subagent containment.**
- Paths: `runs/vendorCliAdapter.ts` (+ per-CLI structured output parsing for usage), `runtimeAdapters/specs.ts` (codex disable config or default-off), usage write via existing metering tables.
- Compatibility: envelope gains usage; no status semantics change.
- Tests: opencode JSONL fixture → usage row asserted; spec conformance test that every `enabled_by_default` local CLI declares a workable `subagent_disable_config`.
- Done when: Supervisor cost caps observe CLI attempts; no default-enabled runtime has uncontrollable subagents.
- Risk: low-medium (usage parsing per CLI version; pin via `runtimeTools` versions).

**Step 5 — Standardize suspension/degrade/terminal reporting.**
- Paths: `runs/orchestrationResults.ts` (typed `status` incl. `suspended`), `runs/managedRetrievalTools.ts` / `managedAgentDelegationTools.ts` (run event + `unresolved_uncertainty` on degrade, turn-limit), docs update in `.agent/architecture/EXECUTION_MODEL.md`.
- Compatibility: `waiting_for_dependency` flow unchanged; sniffing helpers (`waitingForDependencyFromAdapter`) become adapters over the typed field.
- Tests: existing waiting-for-dependency orchestration tests plus one asserting the degrade run event.
- Done when: every non-clean completion path (suspend, degrade, turn-limit, cancel-race) is distinguishable from run evidence alone.
- Risk: low.

---

## Final verdict

1. **Is the runtime boundary explicit or accidental?** Largely **explicit and deliberate**: a single dispatch table (`RUNTIME_EXECUTORS`), a single result envelope, orchestrator-only state writes, policy gates ahead of every invocation, and honest per-adapter capability declarations (`RuntimeAdapterSpec`). Two seams are accidental: the provider-invocation layer's fallback autonomy (H1/V2) and the absence of a single typed request (the de facto request is scattered across run row, input, contract, and adapter_config).
2. **One orchestrator or several?** One **run-level** orchestrator (`RunOrchestrationService`) with legitimate, properly layered domain orchestrators above it (ProjectResearch, Plan/Workflow, AgentGroup rooms — all of which create work only through the run authority and job queue). Below it, `providers/invocation` acts as an unacknowledged micro-orchestrator for provider/model choice — that is the only place where "multiple effective orchestrators" is true today.
3. **Is execution behaviour predictable across runtimes?** For managed runs, largely yes (structured events, policy-gated tools, capped loops). For local CLIs, no — and the repo *knows* it doesn't (opaque observability, null usage, unknown codex delegation) and compensates with trust/conformance/sandbox gates rather than pretending uniformity. That is the right posture; the gaps are telemetry (V3) and codex containment (V5), not architecture.
4. **Most dangerous misplaced responsibility:** effective **model/provider identity of an attempt** — stamped by routing but decided at execution time by the managed adapter's dropped model (V1) and the invocation fallback chain (V2). It corrupts exactly the evidence (route decisions, pass rates, cost) that the Supervisor and routing learn from.
5. **Smallest change with the biggest control/debuggability gain:** Step 1 + Step 2 — honor `model_override_json.model` on the managed path and report actual provider/model per model call in the envelope. Both are additive, require no schema change, and make every later tightening (fallback policy, budget accuracy, routing statistics) trustworthy.
