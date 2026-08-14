# Current Focus

Date: 2026-08-14

**No implementation plan is currently active.** The managed-execution
replatform completed on 2026-08-14; its current behavior is recorded in
[EXECUTION_MODEL.md](../architecture/EXECUTION_MODEL.md),
[runtime-adapters.md](../modules/runtime-adapters.md),
[provider-policy.md](../modules/provider-policy.md), and
[CREDENTIAL_STORAGE.md](../architecture/CREDENTIAL_STORAGE.md).
New work is pulled on demand from
[../plans/backlog.md](../plans/backlog.md); everything trigger-gated lives in
[deferred-register.md](deferred-register.md).

Three follow-on specifications remain —
[runtime-routing-plan.md](../plans/runtime-routing-plan.md),
[scope-model-plan.md](../plans/scope-model-plan.md), and
[capability-shrink-plan.md](../plans/capability-shrink-plan.md) (2026-08-13).
They are specifications, not schedule. Capability-shrink Item 1 amended the
authority documents on 2026-08-14; Items 2–7 remain unscheduled. The routing
and Scope plans are not started.

This file previously declared a three-step sequence — acceptance-readiness
corrections, controlled product acceptance, then unattended hardening. That
sequence was audited on 2026-08-13 against the code and found intact but
unstarted: three weeks of commits went to capture, Inquiry Threads, and the
ontology instead, and not one step of the declared sequence had begun. A focus
document that declares work nobody is doing is worse than one that declares
nothing, because it makes the bypass look orderly. Acceptance is deferred to a
recorded gate below rather than pretended to be imminent.

## Most recent delivered work

The managed-execution replatform and runtime-boundary phases 1–5 landed on
2026-08-14. Managed chat now uses one server-owned vendor registry plus a narrow
pi-ai adapter, the generic multi-turn tool loop is behind the agent-space-owned
`managedAgentLoop` port backed by pi-agent-core, and managed Claude/Codex
subscription OAuth remains owner-only and DB-encrypted. The usage ledger stores
catalog-derived cost separately from explicit `catalog | unknown` cost
provenance, including genuine catalog zeroes, and retains Anthropic's 1h
cache-write subtype without double counting it. Contribution registries now
declare owner-aware duplicate semantics, and Project Research registers its
execution contributions explicitly during app construction. Capability-shrink
Item 1 also made the imported SkillPackage authoritative for skill content while
retaining agent-space ownership of provenance, trust, policy, binding, pinned
delivery, and audit; its remaining implementation items are still only planned.

The Inquiry stage workspace landed on 2026-08-13
(`07f0376e` and `a6ef4efd`). Its current behavior is recorded in
[PROJECTS.md](../architecture/PROJECTS.md) and
[FRONTEND_INFORMATION_ARCHITECTURE.md](../architecture/FRONTEND_INFORMATION_ARCHITECTURE.md);
the completed execution ledger has been retired. The final integration review
found no actionable regressions, and its verification evidence remains in Git
history rather than as a second description of the current system.

## Instance reality

Verified against the running dev instance on 2026-08-13. These facts contradict
several assumptions the retired plans were written under, so check them before
scheduling anything that depends on them.

- **No CLI runtime is installed.** The sandbox image carries `node` only —
  `codex`, `claude`, and `opencode` are all absent, `runtime_tool_bindings` is
  empty, and both `agent_runtime_profiles` rows are `model_api`. Every Run this
  instance has executed went through the managed API path. Anything requiring a
  real CLI — C3 conformance probes, the OpenCode acceptance smoke, CLI
  conversation surfaces — is blocked on installing one first, not on the work
  its plan describes.
- **Always-on has never run.** `autonomy_ticks` is empty. The `autonomous_tick`
  Automation is self-service and nobody has created one, so the capability is
  shipped-but-unactivated rather than shipped-ahead-of-its-gate as previously
  recorded.
- **Scheduled work is live but has never fired.** Three `information_digest`
  Automations are active with a first scheduled execution of 2026-08-14 07:00
  UTC; `automation_runs` is still empty. Source channel scans are also
  scheduled. These execute one predefined job each — unlike `autonomous_tick`,
  they do not choose what to launch.
- **No Run has ever failed or degraded.** 2278 succeeded, 9 waiting for review.
  The failure and degradation paths have never been exercised by real use.

## Gates

Do not treat any of these as scheduled work. Each states what must be true
before a capability may be turned on.

| Gate | Requirement |
|---|---|
| Enabling `autonomous_tick` (Always-on) | Provider-fallback and tool-degradation evidence must be in place, because an autonomously launched Run has nobody reading its result. Satisfied: the `model_provider_mismatch` event already shipped in `bd22c749`, and `managed_tool_degraded` landed 2026-08-13. Keep it satisfied. |
| Any CLI runtime use | Install the runtime into the sandbox image, then run the C3 conformance suite for that runtime×version. Codex additionally carries the cancellation-evidence item in the defer register. Narrowed 2026-08-13: this gate covers spawning a vendor CLI and nothing else. It no longer gates access to subscription capacity, because managed Claude Pro/Max and ChatGPT Codex subscriptions are available through the isolated in-process OAuth channel described by [ADR 0008](../decisions/0008-credential-channel-isolation.md). |
| Enabling retry or Always-on after cost becomes non-null | The Run retry cost cap (`runs/supervisor.ts`) and the autonomy daily cost limit have not yet been calibrated against real catalog-derived spend. Managed chat now writes pi-ai catalog cost to `estimated_cost_usd`; re-check both thresholds against observed values before enabling either feature, rather than discovering them by a run being refused. |
| Controlled product acceptance | Follow [../architecture/PRODUCT_ACCEPTANCE.md](../architecture/PRODUCT_ACCEPTANCE.md). Its OpenCode smoke section cannot run until the CLI gate above is met; the managed-API and Source sections can. |
| Unattended dogfooding | [../plans/unattended-execution-hardening-plan.md](../plans/unattended-execution-hardening-plan.md) must pass its completion gate first. |

## Decisions recorded 2026-08-13

- **Codex internal delegation is not required to be disabled.** Runtime-internal
  subagents do not widen the permission surface: they run in the same worktree
  sandbox, the same freshly cleared `HOME`, behind the same loopback provider
  proxy, and under the same Run cost cap, and file-scope conformance judges the
  resulting worktree diff regardless of which internal agent wrote it. What
  remains is attribution and cancellation quality, and Codex is already priced
  for that — its `unknown` declaration makes the subagent conformance check fail
  by construction, which pins every Codex route at `low` trust. The spec keeps
  `unknown` because that is the truth; inventing a verified value would be
  worse. Cancellation evidence is trigger-gated in the defer register. This
  replaces the former "implement a disable mechanism or make Codex opt-in"
  acceptance blocker.

## Working rules

- Code and schema remain current-state truth while the plans describe target
  state.
- Update the relevant architecture document in the same change that lands a
  behavior.
- Do not introduce compatibility aliases or dual authorities.
- There is no historical data to preserve. Schema changes are edited to their
  final shape in `server/src/db/schema/` and folded into the canonical
  `server/migrations/0001_baseline.sql`; do not add incremental migration files
  or compatibility shims for superseded shapes.
- Internal UUIDs remain valid storage/transport identifiers; users never type
  them in normal product flows.
- Runtime/Provider tests use deterministic fakes in canonical suites. Real
  credentials belong only in explicit integration smoke.
- Database-backed behavior uses the shared real-PostgreSQL fixture. That means
  the migrated template, never a hand-maintained SQL copy of the schema loaded
  into an empty database. Such a copy drifts silently and then cannot fail when
  code and production shape disagree, which is the only thing it exists to
  catch.
- Implementation functions and tests use domain names, never `phase1`,
  `phase2`, `phaseX`, or similar migration-stage names.
- Do not store runtime data, user folders, sandboxes, secrets, databases, or
  logs in the source repository.

## Where the rest lives

| Kind of item | Document |
|---|---|
| Real work with no trigger condition | [../plans/backlog.md](../plans/backlog.md) |
| Anything waiting on a recorded trigger | [deferred-register.md](deferred-register.md) |
| Unattended execution specification | [../plans/unattended-execution-hardening-plan.md](../plans/unattended-execution-hardening-plan.md) |
