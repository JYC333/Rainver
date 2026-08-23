# Unattended Execution Hardening Plan

Date: 2026-07-24
Status: DEFERRED UNTIL CONTROLLED REAL-INTEGRATION SMOKE.
**2026-08-23 (re-pointed):** the missing entry evidence (a real CLI runtime
installed and producing real Run failures) is expected to come from the
execution-topology and Project control-plane plan's P1 real-usage window
(Machine/ExecutionHost/WorkspaceLocation dispatch + Task spine, P0/P1 shipped
2026-08-23; that plan is now retired, git history holds it — carried forward
from the retired control-center and `acp-runtime-replatform-plan.md` lines,
both complete/retired). Re-check the entry trigger after that window closes
rather than scheduling this plan independently.

## Purpose

Harden the already-implemented Run/Attempt/Supervisor/Workflow model for
unattended monitoring and recurring work. This plan does not implement retry
from scratch and does not add cycles to Workflow DAGs.

## Entry trigger

Begin after:

- Project clean cutover and Runtime I/O convergence are complete — both are;
- controlled product acceptance has run;
- one controlled real Provider, Source, and CLI smoke has run;
- observed failure evidence is available to validate retry classification and
  timing.

Controlled local/manual testing does not wait for this plan. Thirty-day
unattended dogfooding does.

Status of the trigger, checked 2026-08-13: none of the last three conditions
holds. Acceptance is gated — see
[../tasks/deferred-register.md](../tasks/deferred-register.md). No CLI runtime
was installed on this instance, so the CLI half of the smoke cannot run at all.
And the failure
evidence this plan needs does not exist: across 2278 Runs there is not one
`failed` or `degraded` record, so retry classification and backoff timing would
be designed against imagined failures. That last point is the substantive reason
to wait, not a bureaucratic one.

## Current implemented baseline

- logical Run plus append-only physical RunAttempt;
- classified transient error allowlist;
- bounded `max_attempts`;
- aggregate Run cost cap;
- deterministic same-route or compatible fallback retry;
- explicit Runtime hard pins;
- waiting-for-review and human resume/abandon;
- orphan recovery and CLI stall timeout;
- managed-call abort propagation and two-phase CLI cancellation;
- normalized Claude Code, Codex, and OpenCode usage in Run envelopes and the
  append-only usage ledger;
- bounded Workflow node re-attempt without graph cycles;
- operation/execution idempotency guards;
- failure notifications and operational alerts at selected boundaries.

The remaining problem is safe scheduling and unattended recovery quality, not
the existence of a retry primitive.

## Retry policy convergence

Create one policy authority for retry classification and schedule calculation.
Adapters and domains emit structured errors; they do not each invent retry
loops.

Required classification:

- transient provider/network/rate-limit/service-unavailable;
- transient runtime/tool startup;
- timeout/stall/orphan;
- policy/approval pause;
- deterministic validation failure;
- invalid input/output contract;
- credential/configuration failure;
- budget/cost exhaustion;
- user cancellation;
- non-idempotent or uncertain side-effect outcome.

Only the first three classes are automatic retry candidates by default.

### Schedule

- bounded exponential backoff;
- jitter;
- optional provider-supplied `retry_after`;
- persisted not-before time;
- restart-safe scheduler pickup;
- maximum elapsed retry window in addition to attempt count;
- no busy loop or immediate recursive scheduling.

The implementation should reuse the existing Job/Scheduler timing authority.
Do not create a second retry scheduler table unless current Job persistence
cannot express a durable not-before time.

### Workflow semantics

- A retry is a new RunAttempt or a new primary node Run according to the
  current owning authority.
- A completed WorkflowExecution is never reopened.
- A new observation/rescan/resume creates a new immutable execution pass where
  Project Research already uses execution-per-pass.
- Backoff does not add graph edges or cycles.
- Domain reconciliation remains idempotent and stale execution ids cannot
  overwrite newer state.

## Managed Research and domain exceptions

Current managed Source/Research runs may intentionally bypass the generic
Supervisor because the owning operation exposes its own retry/review action.
Before unattended monitoring:

- inventory every `isManagedFailFastRun` case;
- decide whether its failure is terminal human review, scheduled new execution
  pass, or eligible generic Attempt retry;
- ensure exactly one authority owns the decision;
- surface the next scheduled attempt/pass and reason in Operations;
- prevent an automatic domain pass and generic Supervisor retry from both
  firing.

Do not generalize from one failure type. Use observed error evidence and
idempotency guarantees.

## Side-effect safety

Automatic retry requires one of:

- no durable side effect occurred;
- the action uses a stable idempotency key and returns the previous result;
- the owning domain can prove reconciliation is safe.

Unknown outcomes go to review. Never retry a potentially duplicated external
write merely because the process disconnected.

Tool calls, source scans, Artifact ingestion, patch Proposal creation,
Knowledge Candidate extraction, and domain reconciliation need explicit
idempotency tests.

## Egress and low-trust context

Before unattended CLI work consumes untrusted external content:

- deny outbound network by default for high/critical local-CLI execution;
- define a separately reviewed egress-enabled profile when a workload needs
  provider/tool network access;
- allowlist destinations/protocols;
- preserve credential-channel isolation;
- record source trust and exposure decisions;
- prevent prompt-injected shell/tool calls from widening egress;
- expose a kill switch per Runtime Adapter and Space;
- recheck current vendor terms before unattended subscription-backed CLI use.

Worktree containment alone is not OS/network isolation.

## Scheduler and automation recovery

- define per-Automation missed-run policy:
  `skip | fire_once | backfill_n`;
- do not silently advance `next_run_at` after an unrecorded failure;
- bound catch-up volume and cost;
- isolate failures between scheduled Project workflows;
- show next run, missed count, retry state, and exhaustion in Operations;
- recover scheduled retries after restart without duplicate fire.

## Alerts and review

At minimum alert on:

- retry scheduled;
- repeated transient failure;
- attempt/window exhaustion;
- budget exhaustion;
- credential/configuration action required;
- policy/approval wait;
- stale/orphan recovery;
- scheduler catch-up truncation;
- failed domain reconciliation;
- egress denial.

Deduplicate by durable subject and failure generation. Routine successful
retries should summarize rather than create permanent high-severity noise.

## Verification

Use deterministic fake time/provider/runtime plus real PostgreSQL for durable
behavior:

- classification table tests;
- backoff/jitter bounds and `retry_after`;
- restart recovery at not-before time;
- max attempt/cost/elapsed-window exhaustion;
- same-route and compatible fallback;
- explicit hard pin;
- idempotent side effect and uncertain-outcome review;
- Workflow DAG remains acyclic;
- completed execution never reopens;
- managed Research has one retry authority;
- scheduler catch-up policies;
- cross-space isolation;
- egress allow/deny and credential isolation;
- alert deduplication and actionable Operations links.

Then run controlled failure injection against one real Provider/CLI without
using production data.

## Valid defers beyond this plan

- ML-based failure/routing prediction;
- unbounded self-healing;
- arbitrary Workflow cycles;
- runtime-session checkpoint/fork/resume;
- exactly-once guarantees for third-party systems that provide no
  idempotency/read-after-write boundary;
- public-internet deployment hardening;
- multi-instance distributed scheduling.

## Completion gate for unattended dogfooding

- transient retries are delayed, bounded, restart-safe, and observable;
- non-retryable/uncertain failures stop for review;
- managed Research and generic Runs have exactly one retry authority each;
- low-trust CLI work has enforceable egress policy;
- scheduler catch-up is explicit and bounded;
- Operations shows retry, alert, approval, and recovery state;
- failure injection proves no duplicate durable or external side effects;
- current-state architecture and runbooks describe the implemented behavior.
